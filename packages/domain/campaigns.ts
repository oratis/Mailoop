import type { PoolClient } from 'pg';
import { RequestError, type Member } from '../db/database.ts';
import { demoPermission, prepareSampleCampaign } from '../agent/coffee-fixture.ts';

export type Draft = ReturnType<typeof prepareSampleCampaign>['draft'];
export type Campaign = {
  id: string; name: string; brief: string; draft: Draft; revision: string; createdAt: string;
  stage: string; receiptId: string | null; reply: string | null;
};
export type CampaignEvent = { sequence: number; type: string; detail: string; occurredAt: string };

export async function appendEvent(client: PoolClient, workspaceId: string, campaignId: string, type: string, detail: string) {
  // Locking the owning campaign makes event cursors follow commit order even under concurrency.
  await client.query(`
    WITH next AS (
      UPDATE campaigns SET event_number = event_number + 1
      WHERE workspace_id = $1 AND id = $2 RETURNING event_number
    )
    INSERT INTO events(workspace_id, campaign_id, sequence, type, detail)
    SELECT $1, $2, event_number, $3, $4 FROM next`, [workspaceId, campaignId, type, detail]);
}

const projection = `SELECT c.id, c.name, c.brief, c.draft, c.revision, c.created_at AS "createdAt",
  CASE WHEN d.reply IS NOT NULL THEN 'replied' ELSE COALESCE(d.state, 'draft') END AS stage,
  d.receipt_id AS "receiptId", d.reply FROM campaigns c
  LEFT JOIN dispatches d ON d.workspace_id = c.workspace_id AND d.campaign_id = c.id`;

export async function listCampaigns(client: PoolClient) {
  return (await client.query<Campaign>(projection + ' ORDER BY c.created_at DESC, c.id')).rows;
}

export async function getCampaign(client: PoolClient, id: string) {
  const result = await client.query<Campaign>(projection + ' WHERE c.id = $1', [id]);
  if (!result.rowCount) throw new RequestError(404, 'Campaign not found.');
  return result.rows[0];
}

function requireReviewer(member: Member) {
  if (member.role !== 'reviewer') throw new RequestError(403, 'A reviewer is required.');
}

export async function createCampaign(client: PoolClient, member: Member, name: unknown) {
  requireReviewer(member);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new RequestError(422, 'Use a campaign name of 1–100 characters.');
  const sample = prepareSampleCampaign();
  const { rows: [campaign] } = await client.query(`
    INSERT INTO campaigns(workspace_id, name, brief, draft) VALUES ($1,$2,$3,$4) RETURNING id`,
    [member.workspaceId, name.trim(), sample.brief, sample.draft]);
  await appendEvent(client, member.workspaceId, campaign.id, 'draft.created', 'Local coffee fixture prepared for review.');
  return getCampaign(client, campaign.id);
}

export async function approveDraft(client: PoolClient, member: Member, id: string, revision: unknown) {
  requireReviewer(member);
  const campaign = await getCampaign(client, id);
  if (revision !== campaign.revision) throw new RequestError(409, 'The revision has changed. Review the current draft.');
  if (campaign.draft.to !== demoPermission.recipient || campaign.draft.mode !== 'simulated') throw new RequestError(422, 'No matching demo permission.');
  const inserted = await client.query(`
    INSERT INTO dispatches(workspace_id,campaign_id,approved_by,revision,state)
    VALUES ($1,$2,$3,$4,'scheduled') ON CONFLICT (workspace_id,campaign_id) DO NOTHING`,
    [member.workspaceId, id, member.id, revision]);
  if (inserted.rowCount) await appendEvent(client, member.workspaceId, id, 'approval.granted', 'Approved by ' + member.name);
  return getCampaign(client, id);
}

export async function readEvents(client: PoolClient, campaignId: string, after: number) {
  await getCampaign(client, campaignId);
  return (await client.query<CampaignEvent>(`
    SELECT sequence, type, detail, occurred_at AS "occurredAt" FROM events
    WHERE campaign_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 100`, [campaignId, after])).rows;
}
