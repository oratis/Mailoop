import type { PoolClient } from 'pg';
import { RequestError, type Member } from '../db/database.ts';
import { field, integer, Vault } from './security.ts';
export type Input = Record<string, unknown>;
export type Context = { db: PoolClient; member: Member; vault: Vault; base: string };
export function requireRole(ctx: Context, ...roles: Member['role'][]) {
  if (ctx.member.role !== 'admin' && !roles.includes(ctx.member.role))
    throw new RequestError(403, 'Insufficient workspace role.');
}
export async function program(ctx: Context, programId: string) {
  const {
    rows: [p]
  } = await ctx.db.query(
    `SELECT p.* FROM programs p WHERE p.id=$1 AND ($2='admin' OR p.owner_id=$3
    OR EXISTS (SELECT 1 FROM program_members pm WHERE pm.program_id=p.id AND pm.member_id=$3))`,
    [programId, ctx.member.role, ctx.member.id]
  );
  if (!p) throw new RequestError(404, 'Campaign not found.');
  return p;
}
export async function lockWorkspace(ctx: Context) {
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ctx.member.workspaceId]);
}
export async function record(
  db: PoolClient,
  workspace: string,
  campaign: string,
  type: string,
  resource: string,
  actor: string | null,
  detail: object = {}
) {
  await db.query('SELECT id FROM programs WHERE id=$1 FOR UPDATE', [campaign]);
  await db.query(
    `INSERT INTO journal(workspace_id,program_id,seq,type,resource_id,actor_id,detail)
    SELECT $1,$2,COALESCE(max(seq),0)+1,$3,$4,$5,$6 FROM journal WHERE program_id=$2`,
    [workspace, campaign, type, resource, actor, detail]
  );
}
export async function newProgram(ctx: Context, body: Input) {
  requireRole(ctx, 'operator', 'reviewer');
  const tz = field(body.timezone ?? 'UTC', 'timezone', 80);
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new RequestError(422, 'Unknown timezone.');
  }
  const start = integer(body.windowStart ?? 0, 'start hour', 0, 23),
    end = integer(body.windowEnd ?? 24, 'end hour', 1, 24);
  if (start >= end) throw new RequestError(422, 'The send window must end after it starts.');
  const facts = Array.isArray(body.facts) ? body.facts : [];
  if (facts.length > 50) throw new RequestError(422, 'Too many brand facts.');
  const verifiedFacts = facts.map((f) => ({
    text: field(f?.text, 'fact'),
    expiresAt: new Date(field(f?.expiresAt, 'fact expiry')).toJSON()
  }));
  if (verifiedFacts.some((f) => !f.expiresAt)) throw new RequestError(422, 'Invalid fact expiry.');
  const {
    rows: [p]
  } = await ctx.db.query(
    `INSERT INTO programs(workspace_id,owner_id,name,brief,purpose,region,timezone,window_start,window_end,cap,facts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      ctx.member.workspaceId,
      ctx.member.id,
      field(body.name, 'name', 100),
      field(body.brief, 'brief', 8000),
      field(body.purpose, 'purpose'),
      field(body.region, 'region', 70),
      tz,
      start,
      end,
      integer(body.cap ?? 50, 'daily cap', 1, 5000),
      JSON.stringify(verifiedFacts)
    ]
  );
  await record(ctx.db, ctx.member.workspaceId, p.id, 'campaign.created', p.id, ctx.member.id);
  return p;
}
export async function listPrograms(ctx: Context) {
  return (
    await ctx.db.query(
      `SELECT p.* FROM programs p WHERE $1='admin' OR owner_id=$2 OR EXISTS
    (SELECT 1 FROM program_members m WHERE m.program_id=p.id AND m.member_id=$2) ORDER BY created_at DESC`,
      [ctx.member.role, ctx.member.id]
    )
  ).rows;
}
export async function changeProgram(ctx: Context, campaign: string, body: Input) {
  requireRole(ctx, 'operator', 'reviewer');
  await lockWorkspace(ctx);
  const p = await program(ctx, campaign);
  if (!['active', 'paused', 'completed'].includes(String(body.status)) || p.status === 'completed')
    throw new RequestError(409, 'Invalid campaign transition.');
  await ctx.db.query('UPDATE programs SET status=$2 WHERE id=$1', [campaign, body.status]);
  await record(
    ctx.db,
    ctx.member.workspaceId,
    campaign,
    'campaign.' + body.status,
    campaign,
    ctx.member.id
  );
  return program(ctx, campaign);
}
