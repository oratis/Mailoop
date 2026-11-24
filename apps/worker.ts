import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { asWorkspace } from '../packages/db/database.ts';
import { appendEvent } from '../packages/domain/campaigns.ts';
import { SimulatedMailbox } from '../packages/connectors/simulated-mailbox.ts';

type Job = { id: string; campaignId: string; state: 'scheduled' | 'submitting' | 'unknown' | 'accepted' };

export async function processOne(pool: Pool, mailbox: SimulatedMailbox, workspaceId: string) {
  const lease = randomUUID();
  const job = await asWorkspace(pool, workspaceId, async client => {
    const { rows: [row] } = await client.query<Job>(`
      SELECT id, campaign_id AS "campaignId", state FROM dispatches
      WHERE reply IS NULL AND due_at <= now()
      ORDER BY due_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!row) return null;
    const state = row.state === 'scheduled' ? 'submitting' : row.state === 'submitting' ? 'unknown' : row.state;
    await client.query("UPDATE dispatches SET state=$2, lease_id=$3, due_at=now()+interval '30 seconds' WHERE id=$1",
      [row.id, state, lease]);
    if (row.state !== state) await appendEvent(client, workspaceId, row.campaignId, 'dispatch.' + state,
      state === 'submitting' ? 'Submitting to the simulated mailbox.' : 'Expired attempt moved to reconciliation.');
    return row;
  });
  if (!job) return false;

  const receipt = job.state === 'scheduled'
    ? await mailbox.submit(workspaceId, job.id)
    : await mailbox.lookup(workspaceId, job.id);
  await asWorkspace(pool, workspaceId, async client => {
    const locked = await client.query('SELECT id FROM dispatches WHERE id=$1 AND lease_id=$2 FOR UPDATE', [job.id, lease]);
    if (!locked.rowCount) return;
    if (!receipt) {
      const delay = job.state === 'scheduled' ? 0 : 30;
      // A missing lookup cannot establish that an interrupted handoff never reached the provider.
      await client.query(`UPDATE dispatches SET state=$2, lease_id=NULL,
        due_at=now()+make_interval(secs => $3) WHERE id=$1`,
        [job.id, job.state === 'accepted' ? 'accepted' : 'unknown', delay]);
      if (job.state === 'scheduled') await appendEvent(client, workspaceId, job.campaignId, 'dispatch.unknown', 'Receipt unavailable. Waiting for reconciliation.');
    } else if (job.state === 'accepted') {
      await client.query('UPDATE dispatches SET reply=$2, lease_id=NULL WHERE id=$1', [job.id, receipt.reply]);
      await appendEvent(client, workspaceId, job.campaignId, 'inbound.matched', 'Simulated reply matched to this campaign.');
    } else {
      await client.query("UPDATE dispatches SET state='accepted', receipt_id=$2, lease_id=NULL, due_at=now() WHERE id=$1",
        [job.id, receipt.receiptId]);
      await appendEvent(client, workspaceId, job.campaignId, 'dispatch.accepted',
        job.state === 'scheduled' ? 'Simulated mailbox accepted the draft.' : 'Recovered the existing receipt from the simulated mailbox.');
    }
  });
  return true;
}
