import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { asWorkspace, RequestError } from '../db/database.ts';
import { accessMailbox, MailboxError } from './mailbox-auth.ts';
import { gates, suppress, type LetterBody } from './letters.ts';
import { record } from './context.ts';
import {
  CloudDraft,
  messageId,
  readRelated,
  reconcileMail,
  submitMail,
  type InboundMail
} from './mail-transports.ts';
import { address, Vault } from './security.ts';
import { SimulatedMailbox } from '../connectors/simulated-mailbox.ts';

function classify(text: string, automatic: boolean) {
  if (automatic) return 'auto_reply';
  if (/unsubscribe|stop (?:emailing|contacting)|remove me|退订|不要再联系|配信停止/i.test(text))
    return 'opt_out';
  if (/not interested|婉拒|結構です/i.test(text)) return 'declined';
  if (/interested|let.s collaborate|有兴趣|興味があります/i.test(text)) return 'interested';
  if (/rate card|报价|見積|pricing/i.test(text)) return 'quote';
  if (/[?？]/.test(text)) return 'question';
  return 'reply';
}
export async function ingest(
  db: PoolClient,
  ws: string,
  vault: Vault,
  letterId: string,
  event: InboundMail,
  kind?: string
) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ws]);
  const {
    rows: [l]
  } = await db.query(
    'SELECT l.*,r.contact_key,r.program_id FROM letters l JOIN prospects r ON r.id=l.prospect_id WHERE l.id=$1',
    [letterId]
  );
  if (!l || !l.attempted_at) throw new RequestError(409, 'No outbound handoff to match.');
  const draft = vault.open<LetterBody>(ws, l.sealed);
  if (!event.references.includes(messageId(l.id, draft.from)) || address(event.from) !== draft.to)
    throw new RequestError(422, 'Thread or recipient mismatch.');
  const type = kind ?? classify(event.text, event.auto);
  const inserted = await db.query(
    `INSERT INTO inbound(workspace_id,mailbox_id,source_id,letter_id,kind,sealed,received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
    [ws, l.mailbox_id, event.sourceId, l.id, type, vault.seal(ws, event), event.at]
  );
  if (!inserted.rowCount) return { duplicate: true };
  if (['opt_out', 'hard_bounce', 'complaint'].includes(type))
    await suppress(db, ws, l.contact_key, type);
  if (!['auto_reply', 'soft_bounce'].includes(type)) {
    await db.query(
      `UPDATE letters SET status='cancelled',reason='reply_received' WHERE prospect_id=$1 AND step='followup' AND status IN ('scheduled','draft','held')`,
      [l.prospect_id]
    );
    await db.query(`UPDATE prospects SET stage=$2 WHERE id=$1 AND stage NOT IN ('won','closed')`, [
      l.prospect_id,
      ['declined', 'opt_out', 'hard_bounce', 'complaint'].includes(type) ? 'closed' : 'replied'
    ]);
  }
  await record(db, ws, l.program_id, 'inbound.' + type, inserted.rows[0].id, null);
  return { id: inserted.rows[0].id, kind: type };
}
export async function deliveryTick(
  pool: Pool,
  ws: string,
  vault: Vault,
  base: string,
  allowReal: boolean
) {
  const lease = randomUUID();
  const job = await asWorkspace(pool, ws, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ws]);
    const {
      rows: [l]
    } =
      await db.query(`SELECT * FROM letters WHERE status IN ('scheduled','submitting','unknown','accepted','provider_draft')
      AND due_at<=now() AND (status<>'accepted' OR NOT EXISTS(SELECT 1 FROM prospects p WHERE p.id=letters.prospect_id AND p.erased_at IS NOT NULL)) ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!l) return null;
    const { row, reason } = await gates(db, l.id);
    if (l.status === 'scheduled') {
      if (reason === 'sync_required') {
        await db.query(
          "UPDATE letters SET due_at=LEAST(due_at,now()) WHERE id=$1 AND status='accepted'",
          [l.parent_id]
        );
        await db.query(
          "UPDATE letters SET due_at=now()+interval '2 minutes',reason='sync_required' WHERE id=$1",
          [l.id]
        );
        return null;
      }
      if (reason || (!allowReal && row.provider !== 'simulated')) {
        await db.query("UPDATE letters SET status='held',reason=$2 WHERE id=$1", [
          l.id,
          reason ?? 'external_delivery_disabled'
        ]);
        return null;
      }
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: row.timezone,
          hour: '2-digit',
          hourCycle: 'h23'
        }).format(new Date())
      );
      const {
        rows: [q]
      } = await db.query(
        `SELECT count(*)::int AS org,count(*) FILTER(WHERE x.mailbox_id=$1)::int AS mailbox,
        count(*) FILTER(WHERE p.program_id=$2)::int AS campaign FROM letters x JOIN prospects p ON p.id=x.prospect_id WHERE x.attempted_at>now()-interval '24 hours'
        AND x.status IN ('submitting','unknown','accepted')`,
        [l.mailbox_id, row.program_id]
      );
      if (
        hour < row.window_start ||
        hour >= row.window_end ||
        q.org >= Number(process.env.MAILOOP_ORG_DAILY_CAP ?? 500) ||
        q.mailbox >= row.mailbox_cap ||
        q.campaign >= row.campaign_cap
      ) {
        await db.query(
          "UPDATE letters SET due_at=now()+interval '15 minutes',reason='window_or_capacity' WHERE id=$1",
          [l.id]
        );
        return null;
      }
    }
    let account;
    try {
      account = await accessMailbox(db, vault, ws, l.mailbox_id);
    } catch {
      await db.query(
        `UPDATE letters SET status=CASE WHEN status='scheduled' THEN 'held' WHEN status='submitting' THEN 'unknown' ELSE status END,reason='reauth_required',due_at=now()+interval '1 hour' WHERE id=$1`,
        [l.id]
      );
      return null;
    }
    const draft = vault.open<LetterBody>(ws, l.sealed);
    if (
      l.status === 'scheduled' &&
      (account.email !== draft.from ||
        (account.provider === 'simulated' && !draft.to.endsWith('.example')))
    ) {
      await db.query("UPDATE letters SET status='held',reason='identity_mismatch' WHERE id=$1", [l.id]);
      return null;
    }
    const next =
      l.status === 'scheduled' ? 'submitting' : l.status === 'submitting' ? 'unknown' : l.status;
    await db.query(
      `UPDATE letters SET lease_id=$2,due_at=now()+interval '3 minutes',status=$3,reason=NULL,
      attempted_at=CASE WHEN $3='submitting' THEN now() ELSE attempted_at END WHERE id=$1`,
      [l.id, lease, next]
    );
    return { l, account, draft, campaign: row.program_id, contact: row.contact_key };
  });
  if (!job) return false;
  const { l, account, draft, campaign, contact } = job;
  let retryAfterMs = 300000;
  let cloudDraft: string | undefined;
  let receipt: string | undefined,
    errorCode: string | undefined,
    definitive = false,
    related: InboundMail[] = [];
  const scanUntil = new Date();
  try {
    if (l.status === 'scheduled' && account.provider === 'simulated') {
      const upstream = await new SimulatedMailbox(pool, account.basic?.loseReceipt === true).submit(
        ws,
        l.id
      );
      receipt = upstream?.receiptId;
    } else if (l.status !== 'scheduled' && l.status !== 'accepted' && account.provider === 'simulated') {
      receipt = (await new SimulatedMailbox(pool).lookup(ws, l.id))?.receiptId;
    } else if (l.status === 'scheduled') {
      const approved = vault.open<{ raw: string; unsubscribe: string }>(ws, l.approved_mime);
      const raw = Buffer.from(approved.raw, 'base64');
      if (createHash('sha256').update(raw).digest('hex') !== l.approved_digest)
        throw new RequestError(422, 'Approval digest changed.');
      receipt = await submitMail(
        account,
        { ...draft, id: l.id, unsubscribe: approved.unsubscribe },
        raw
      );
    } else if (l.status === 'accepted')
      related = await readRelated(account, { ...l, scanUntil }, draft.to);
    else receipt = await reconcileMail(account, l.id);
  } catch (e) {
    if (e instanceof CloudDraft) cloudDraft = e.draftId;
    if (e instanceof MailboxError && e.retryAfterMs)
      retryAfterMs = Math.max(retryAfterMs, e.retryAfterMs);
    errorCode = e instanceof RequestError ? 'provider_' + e.status : 'connection_interrupted';
    definitive =
      l.status === 'scheduled' &&
      e instanceof RequestError &&
      [400, 401, 403, 404, 413, 422, 429].includes(e.status);
  }
  await asWorkspace(pool, ws, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ws]);
    if (
      !(await db.query('SELECT id FROM letters WHERE id=$1 AND lease_id=$2 FOR UPDATE', [l.id, lease]))
        .rowCount
    )
      return;
    if (l.status === 'accepted') {
      for (const item of related) await ingest(db, ws, vault, l.id, item);
      await db.query(
        "UPDATE letters SET lease_id=NULL,reason=$2,checked_at=CASE WHEN $2::text IS NULL THEN $3 ELSE checked_at END,due_at=now()+CASE WHEN accepted_at<now()-interval '15 days' THEN interval '1 day' ELSE interval '5 minutes' END WHERE id=$1",
        [l.id, errorCode ?? null, scanUntil]
      );
      if (!errorCode) await db.query('UPDATE mailboxes SET synced_at=now() WHERE id=$1', [l.mailbox_id]);
    } else if (receipt) {
      await db.query(
        "UPDATE letters SET status='accepted',accepted_at=coalesce(accepted_at,attempted_at),receipt=$2,lease_id=NULL,due_at=now() WHERE id=$1",
        [l.id, receipt]
      );
      await db.query("UPDATE prospects SET stage='contacted' WHERE id=$1 AND stage='shortlisted'", [
        l.prospect_id
      ]);
      await record(db, ws, campaign, 'dispatch.accepted', l.id, null);
    } else {
      const status =
        cloudDraft || l.status === 'provider_draft'
          ? 'provider_draft'
          : definitive
            ? errorCode === 'provider_429'
              ? 'scheduled'
              : 'held'
            : 'unknown';
      await db.query(
        "UPDATE letters SET status=$2,reason=$3,receipt=coalesce($5,receipt),lease_id=NULL,due_at=now()+$4*interval '1 millisecond' WHERE id=$1",
        [
          l.id,
          status,
          status === 'provider_draft'
            ? 'awaiting_mailbox_owner'
            : (errorCode ?? 'reconciliation_inconclusive'),
          retryAfterMs,
          cloudDraft ?? null
        ]
      );
      if (l.status !== status) await record(db, ws, campaign, 'dispatch.' + status, l.id, null);
    }
  });
  return true;
}
