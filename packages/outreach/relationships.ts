import { RequestError } from '../db/database.ts';
import { type Context, lockWorkspace, record, requireRole } from './context.ts';
import { prospect, type Candidate } from './imports.ts';
import { address, integer } from './security.ts';

export async function setContact(ctx: Context, creator: string, index: unknown) {
  requireRole(ctx, 'reviewer', 'operator');
  await lockWorkspace(ctx);
  const r = await prospect(ctx, creator);
  const ws = ctx.member.workspaceId,
    data = ctx.vault.open<Candidate>(ws, r.sealed);
  const n = integer(index, 'contact index', 0, data.contacts.length - 1);
  if (n === 0) return { ok: true };
  if (
    (
      await ctx.db.query('SELECT 1 FROM letters WHERE prospect_id=$1 AND attempted_at IS NOT NULL', [
        r.id
      ])
    ).rowCount
  )
    throw new RequestError(409, 'A submitted conversation has a fixed recipient.');
  const [selected] = data.contacts.splice(n, 1);
  data.contacts.unshift(selected);
  await ctx.db.query(
    "UPDATE letters SET status='cancelled',reason='recipient_changed' WHERE prospect_id=$1 AND status IN ('draft','held','scheduled')",
    [r.id]
  );
  await ctx.db.query(
    'UPDATE prospects SET sealed=$2,contact_key=$3,evidence_ok=false,verified_by=NULL WHERE id=$1',
    [r.id, ctx.vault.seal(ws, data), ctx.vault.hash(ws, address(selected.address))]
  );
  await record(ctx.db, ws, r.program_id, 'creator.contact_changed', r.id, ctx.member.id);
  return { ok: true };
}
export async function mergeChannels(ctx: Context, primary: string, duplicate: string) {
  requireRole(ctx, 'reviewer');
  await lockWorkspace(ctx);
  const r = await prospect(ctx, primary),
    other = await prospect(ctx, duplicate);
  if (r.id === other.id || r.program_id !== other.program_id || r.erased_at || other.erased_at)
    throw new RequestError(409, 'Choose two current records in one campaign.');
  if (
    (
      await ctx.db.query(
        'SELECT 1 FROM letters WHERE prospect_id=$1 UNION ALL SELECT 1 FROM outcomes WHERE prospect_id=$1',
        [other.id]
      )
    ).rowCount
  )
    throw new RequestError(409, 'The duplicate already has an outreach or business history.');
  const ws = ctx.member.workspaceId,
    data = ctx.vault.open<Candidate>(ws, r.sealed),
    copy = ctx.vault.open<Candidate>(ws, other.sealed);
  const combined = [...data.contacts];
  for (const c of copy.contacts) if (!combined.some((k) => k.address === c.address)) combined.push(c);
  data.contacts = combined;
  if (combined.length) delete data.missingReason;
  const key = combined.length ? ctx.vault.hash(ws, address(combined[0].address)) : null;
  await ctx.db.query('UPDATE prospects SET sealed=$2,contact_key=$3 WHERE id=$1', [
    r.id,
    ctx.vault.seal(ws, data),
    key
  ]);
  await ctx.db.query('INSERT INTO other_channels VALUES($1,$2,$3,$4)', [
    ws,
    r.program_id,
    other.channel_key,
    r.id
  ]);
  await ctx.db.query('UPDATE other_channels SET prospect_id=$2 WHERE prospect_id=$1', [other.id, r.id]);
  await ctx.db.query('DELETE FROM prospects WHERE id=$1', [other.id]);
  await record(ctx.db, ws, r.program_id, 'creator.merged', r.id, ctx.member.id, { duplicate: other.id });
  return { id: r.id };
}
export async function relatedCampaigns(ctx: Context, creator: string) {
  requireRole(ctx, 'reviewer', 'operator', 'researcher');
  const r = await prospect(ctx, creator);
  return (
    await ctx.db.query(
      `WITH channels AS (SELECT id,channel_key FROM prospects UNION ALL SELECT prospect_id,channel_key FROM other_channels)
    SELECT DISTINCT p.id AS creator_id,c.id AS campaign_id,c.name,p.stage FROM prospects p JOIN programs c ON c.id=p.program_id
    JOIN channels known ON known.id=p.id WHERE known.channel_key IN(SELECT channel_key FROM channels WHERE id=$1)
    AND (c.owner_id=$2 OR $3='admin' OR EXISTS(SELECT 1 FROM program_members pm WHERE pm.program_id=c.id AND pm.member_id=$2)) ORDER BY c.name`,
      [r.id, ctx.member.id, ctx.member.role]
    )
  ).rows;
}
