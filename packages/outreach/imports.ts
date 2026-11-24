import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RequestError } from '../db/database.ts';
import { type Context, type Input, lockWorkspace, program, record, requireRole } from './context.ts';
import { address, field, id, instant } from './security.ts';
export type Contact = {
  source: 'public_business_page' | 'licensed_vendor';
  address: string;
  evidenceUrl?: string;
  evidenceExcerpt?: string;
  vendor?: string;
  recordRef?: string;
  observedAt: string;
};
export type Candidate = {
  displayName: string;
  language: string;
  channelUrl: string;
  matchReason: string;
  work: { url: string; publishedOn: string | null };
  contacts: Contact[];
  missingReason?: string;
};
export type Artifact = {
  schemaVersion: 1;
  runId: string;
  briefRevision: string;
  researchedAt: string;
  candidates: Candidate[];
};
const ajv = new Ajv2020({ allErrors: false, strictTypes: false });
(formats as unknown as (a: Ajv2020) => void)(ajv);
export const researchSchema = JSON.parse(
  readFileSync(new URL('../../docs/examples/research-result.schema.json', import.meta.url), 'utf8')
);
const validate = ajv.compile<Artifact>(researchSchema);
export function artifact(input: unknown): Artifact {
  if (!validate(input))
    throw new RequestError(
      422,
      'Invalid research artifact at ' + (validate.errors?.[0]?.instancePath || '/')
    );
  for (const c of input.candidates) for (const contact of c.contacts) address(contact.address);
  return input;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)])
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
function channelKey(c: Candidate) {
  const u = new URL(c.channelUrl);
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}
async function decisions(ctx: Context, campaign: string, a: Artifact) {
  const seen = new Set<string>(
    (
      await ctx.db.query(
        'SELECT channel_key FROM prospects WHERE program_id=$1 UNION SELECT channel_key FROM other_channels WHERE program_id=$1',
        [campaign]
      )
    ).rows.map((r) => r.channel_key)
  );
  const keys = a.candidates
    .map((c) => c.contacts[0] && ctx.vault.hash(ctx.member.workspaceId, address(c.contacts[0].address)))
    .filter(Boolean);
  const suppressed = new Set(
    (
      await ctx.db.query('SELECT contact_key FROM suppressions WHERE contact_key=ANY($1::text[])', [
        keys
      ])
    ).rows.map((r) => r.contact_key)
  );
  return a.candidates.map((c) => {
    const channel = channelKey(c),
      contact = c.contacts[0],
      key = contact && ctx.vault.hash(ctx.member.workspaceId, address(contact.address));
    const status = seen.has(channel)
      ? 'duplicate'
      : key && suppressed.has(key)
        ? 'suppressed'
        : contact
          ? 'needs_review'
          : 'missing_evidence';
    seen.add(channel);
    return status;
  });
}
export async function preview(ctx: Context, campaign: string, input: unknown) {
  requireRole(ctx, 'operator', 'reviewer', 'researcher');
  const p = await program(ctx, campaign);
  const a = artifact(input),
    hash = digest(a);
  await lockWorkspace(ctx);
  const prior = (await ctx.db.query('SELECT * FROM imports WHERE run_key=$1', [a.runId])).rows[0];
  if (prior && (prior.digest !== hash || prior.program_id !== campaign))
    throw new RequestError(409, 'Research run ID already used with different input.');
  if (prior?.applied_at)
    return { previewId: prior.id, digest: hash, decisions: prior.decisions, applied: true };
  if (a.briefRevision !== String(p.version))
    throw new RequestError(409, 'Research refers to another brief revision.');
  const rows = await decisions(ctx, campaign, a);
  const inserted = await ctx.db.query(
    `INSERT INTO imports(workspace_id,program_id,run_key,digest,sealed,decisions)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,run_key) DO UPDATE SET decisions=excluded.decisions,created_at=now()
    RETURNING id`,
    [
      ctx.member.workspaceId,
      campaign,
      a.runId,
      hash,
      ctx.vault.seal(ctx.member.workspaceId, a),
      JSON.stringify(rows)
    ]
  );
  return { previewId: inserted.rows[0].id, digest: hash, decisions: rows, applied: false };
}
export async function applyImport(ctx: Context, campaign: string, b: Input) {
  requireRole(ctx, 'operator', 'reviewer', 'researcher');
  await lockWorkspace(ctx);
  const p = await program(ctx, campaign);
  const batch = (
    await ctx.db.query('SELECT * FROM imports WHERE id=$1 AND program_id=$2 FOR UPDATE', [
      id(b.previewId),
      campaign
    ])
  ).rows[0];
  if (!batch || batch.digest !== b.digest) throw new RequestError(409, 'Preview does not match.');
  if (batch.applied_at) return { applied: true, decisions: batch.decisions };
  const a = ctx.vault.open<Artifact>(ctx.member.workspaceId, batch.sealed),
    rows = await decisions(ctx, campaign, a);
  if (
    p.status !== 'active' ||
    String(p.version) !== a.briefRevision ||
    Date.now() - batch.created_at.getTime() > 3600000 ||
    digest(rows) !== digest(batch.decisions)
  )
    throw new RequestError(409, 'Refresh the import preview.');
  for (const [i, c] of a.candidates.entries()) {
    if (['duplicate', 'suppressed'].includes(rows[i])) continue;
    const k = c.contacts[0]
      ? ctx.vault.hash(ctx.member.workspaceId, address(c.contacts[0].address))
      : null;
    await ctx.db.query(
      'INSERT INTO prospects(workspace_id,program_id,channel_key,contact_key,sealed) VALUES($1,$2,$3,$4,$5)',
      [ctx.member.workspaceId, campaign, channelKey(c), k, ctx.vault.seal(ctx.member.workspaceId, c)]
    );
  }
  await ctx.db.query('UPDATE imports SET applied_at=now() WHERE id=$1', [batch.id]);
  await record(ctx.db, ctx.member.workspaceId, campaign, 'import.applied', batch.id, ctx.member.id, {
    count: a.candidates.length
  });
  return { applied: true, decisions: rows };
}
export async function prospect(ctx: Context, prospectId: string) {
  const r = (await ctx.db.query('SELECT * FROM prospects WHERE id=$1', [prospectId])).rows[0];
  if (!r) throw new RequestError(404, 'Creator not found.');
  await program(ctx, r.program_id);
  return r;
}
export async function attest(ctx: Context, prospectId: string, b: Input) {
  requireRole(ctx, 'reviewer');
  await lockWorkspace(ctx);
  const r = await prospect(ctx, prospectId),
    p = await program(ctx, r.program_id);
  if (!r.contact_key) throw new RequestError(422, 'Creator has no contact point.');
  if (b.action === 'revoke') {
    await ctx.db.query('DELETE FROM consents WHERE contact_key=$1 AND purpose=$2 AND region=$3', [
      r.contact_key,
      p.purpose,
      p.region
    ]);
  } else {
    const proof = field(b.proof, 'consent record', 2000),
      expires = instant(b.expiresAt);
    if (b.confirmed !== true || expires <= new Date())
      throw new RequestError(422, 'Confirm verified evidence and unexpired opt-in for this purpose.');
    const evidenceUntil = b.evidenceExpiresAt
      ? instant(b.evidenceExpiresAt)
      : new Date(Date.now() + 90 * 86400000);
    if (evidenceUntil <= new Date()) throw new RequestError(422, 'Review the expired source evidence.');
    await ctx.db.query(
      'UPDATE prospects SET evidence_ok=true,verified_by=$2,evidence_until=$3 WHERE id=$1',
      [r.id, ctx.member.id, evidenceUntil]
    );
    await ctx.db.query(
      `INSERT INTO consents(workspace_id,contact_key,purpose,region,sealed,expires_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(workspace_id,contact_key,purpose,region) DO UPDATE SET sealed=excluded.sealed,expires_at=excluded.expires_at,actor_id=excluded.actor_id`,
      [
        ctx.member.workspaceId,
        r.contact_key,
        p.purpose,
        p.region,
        ctx.vault.seal(ctx.member.workspaceId, { proof, at: new Date() }),
        expires,
        ctx.member.id
      ]
    );
  }
  await record(
    ctx.db,
    ctx.member.workspaceId,
    p.id,
    'permission.' + (b.action === 'revoke' ? 'revoked' : 'granted'),
    r.id,
    ctx.member.id
  );
  return { ok: true };
}
