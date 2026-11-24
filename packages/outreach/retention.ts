import type { Pool } from 'pg';
import { asWorkspace } from '../db/database.ts';
import { type Context, type Input, requireRole, lockWorkspace, record } from './context.ts';
import { integer, Vault } from './security.ts';
import { prospect, type Artifact, type Candidate } from './imports.ts';
import { suppress, type LetterBody } from './letters.ts';

export async function policy(ctx: Context, update?: Input) {
  requireRole(ctx);
  if (update) {
    const days =
      update.retentionDays === null ? null : integer(update.retentionDays, 'retention days', 1, 3650);
    await ctx.db.query(
      'INSERT INTO workspace_policies(workspace_id,retention_days) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET retention_days=$2,last_cleanup=NULL',
      [ctx.member.workspaceId, days]
    );
  }
  return (
    (await ctx.db.query('SELECT retention_days,last_cleanup FROM workspace_policies')).rows[0] ?? {
      retention_days: null,
      last_cleanup: null
    }
  );
}
export async function cleanup(pool: Pool, ws: string, vault: Vault) {
  return asWorkspace(pool, ws, async (db) => {
    await db.query('DELETE FROM oauth_states WHERE expires_at<now()');
    const config = (
      await db.query(
        "UPDATE workspace_policies SET last_cleanup=now() WHERE retention_days IS NOT NULL AND (last_cleanup IS NULL OR last_cleanup<now()-interval '1 day') RETURNING retention_days"
      )
    ).rows[0];
    if (!config) return;
    const since = new Date(Date.now() - config.retention_days * 86400000);
    await db.query('DELETE FROM imports WHERE applied_at IS NULL AND created_at<$1', [since]);
    await db.query("UPDATE imports SET sealed='' WHERE applied_at<$1 AND sealed<>''", [since]);
    await db.query('DELETE FROM draft_history WHERE superseded_at<$1', [since]);
    await db.query("DELETE FROM inbound WHERE kind='unmatched' AND received_at<$1", [since]);
    await db.query('UPDATE inbound SET sealed=$1,redacted=true WHERE NOT redacted AND received_at<$2', [
      vault.seal(ws, { text: '' }),
      since
    ]);
    await db.query(
      "UPDATE runs SET checkpoint=NULL WHERE status IN ('completed','cancelled') AND created_at<$1",
      [since]
    );
  });
}
export async function eraseCreator(ctx: Context, key: string) {
  requireRole(ctx);
  await lockWorkspace(ctx);
  const r = await prospect(ctx, key),
    ws = ctx.member.workspaceId;
  if (r.erased_at) return { erased: true };
  if (r.contact_key) await suppress(ctx.db, ws, r.contact_key, 'erasure');
  const tombstone: Candidate = {
    displayName: 'Removed creator',
    channelUrl: 'https://removed.example/' + r.id,
    contacts: [],
    missingReason: 'erased',
    language: 'und',
    matchReason: 'Removed',
    work: { url: 'https://removed.example/', publishedOn: null }
  };
  const channels = new Set([
    r.channel_key,
    ...(
      await ctx.db.query('SELECT channel_key FROM other_channels WHERE prospect_id=$1', [r.id])
    ).rows.map((x) => x.channel_key)
  ]);
  await ctx.db.query('DELETE FROM other_channels WHERE prospect_id=$1', [r.id]);
  // Purge the raw import snapshot as well. Keep the digest of applied batches for replay.
  for (const batch of (
    await ctx.db.query("SELECT id,sealed,applied_at FROM imports WHERE program_id=$1 AND sealed<>''", [
      r.program_id
    ])
  ).rows) {
    const rows = ctx.vault.open<Artifact>(ws, batch.sealed).candidates;
    if (!rows.some((c) => channels.has(c.channelUrl.replace(/\/$/, '')) || channels.has(c.channelUrl)))
      continue;
    if (batch.applied_at) await ctx.db.query("UPDATE imports SET sealed='' WHERE id=$1", [batch.id]);
    else await ctx.db.query('DELETE FROM imports WHERE id=$1', [batch.id]);
  }
  const letters = (await ctx.db.query('SELECT id,sealed FROM letters WHERE prospect_id=$1', [r.id]))
    .rows;
  for (const l of letters) {
    const { from } = ctx.vault.open<LetterBody>(ws, l.sealed);
    await ctx.db.query(
      "UPDATE letters SET approved_mime=NULL,sealed=$2,status=CASE WHEN status IN ('scheduled','draft','held') THEN 'cancelled' ELSE status END WHERE id=$1",
      [
        l.id,
        ctx.vault.seal(ws, { from, to: 'removed@removed.example', subject: 'Removed message', body: '' })
      ]
    );
  }
  await ctx.db.query(
    'DELETE FROM draft_history WHERE letter_id IN (SELECT id FROM letters WHERE prospect_id=$1)',
    [r.id]
  );
  await ctx.db.query(
    'UPDATE inbound SET sealed=$2,redacted=true WHERE letter_id IN (SELECT id FROM letters WHERE prospect_id=$1)',
    [r.id, ctx.vault.seal(ws, { text: '' })]
  );
  await ctx.db.query(
    "UPDATE prospects SET sealed=$2,channel_key=$3,evidence_ok=false,shortlisted=false,stage='closed',erased_at=now() WHERE id=$1",
    [r.id, ctx.vault.seal(ws, tombstone), tombstone.channelUrl]
  );
  if (r.contact_key) await ctx.db.query('DELETE FROM consents WHERE contact_key=$1', [r.contact_key]);
  await record(ctx.db, ws, r.program_id, 'creator.erased', r.id, ctx.member.id);
  return { erased: true };
}
