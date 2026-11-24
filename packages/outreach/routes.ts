import { installedSkills } from './skills.ts';
import { installedConnectors } from '../connectors/sdk.ts';
import { bridgeSecret, unmatched } from './ingress.ts';
import type { Pool } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { asWorkspace, RequestError } from '../db/database.ts';
import {
  type Context,
  type Input,
  newProgram,
  listPrograms,
  program,
  changeProgram,
  requireRole,
  lockWorkspace,
  record
} from './context.ts';
import { id, field, integer, instant, Vault } from './security.ts';
import { applyImport, attest, preview, prospect, type Candidate } from './imports.ts';
import { makeDraft, editDraft, approveBatch, letter, suppress, type LetterBody } from './letters.ts';
import { bindModel } from './models.ts';
import { startRun, runAction } from './runs.ts';
import { startOAuth, directMailbox, grantMailbox } from './mailbox-auth.ts';
import { outcome, report } from './reports.ts';
import { ingest } from './delivery.ts';
import { messageId } from './mail-transports.ts';
export type Settings = { vault: Vault; base: string; allowReal: boolean; defaultWorkspace?: boolean };
export async function unsubscribe(pool: Pool, vault: Vault, token: string) {
  const [ws, key] = vault.verify('unsubscribe', token).split('/');
  if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw new RequestError(400, 'Invalid unsubscribe link.');
  await asWorkspace(pool, id(ws), (db) => suppress(db, ws, key, 'unsubscribe'));
  return { ok: true };
}
async function overview(ctx: Context, campaign: string) {
  const p = await program(ctx, campaign);
  const summary = await report(ctx, campaign, null, null);
  if (['analyst', 'viewer'].includes(ctx.member.role))
    return { campaign: p, summary, prospects: [], letters: [], inbox: [], runs: [], events: [] };
  const ws = ctx.member.workspaceId;
  const prospects = (
    await ctx.db.query(
      'SELECT id,sealed,evidence_ok,shortlisted,stage FROM prospects WHERE program_id=$1 ORDER BY channel_key',
      [campaign]
    )
  ).rows.map((r) => ({
    id: r.id,
    verified: r.evidence_ok,
    shortlisted: r.shortlisted,
    stage: r.stage,
    ...ctx.vault.open<Candidate>(ws, r.sealed)
  }));
  const runs = (
    await ctx.db.query(
      'SELECT id,step,status,calls,budget,note FROM runs WHERE program_id=$1 AND owner_id=$2 ORDER BY created_at DESC',
      [campaign, ctx.member.id]
    )
  ).rows;
  const events = (
    await ctx.db.query(
      'SELECT seq,type,resource_id,at,detail FROM journal WHERE program_id=$1 ORDER BY seq DESC LIMIT 100',
      [campaign]
    )
  ).rows;
  if (ctx.member.role === 'researcher')
    return { campaign: p, summary, prospects, runs, events, letters: [], inbox: [] };
  const letters = (
    await ctx.db.query(
      `SELECT l.id,l.revision,l.step,l.status,l.reason,l.mailbox_id,l.prospect_id,l.sealed,l.approved_by,l.accepted_at FROM letters l JOIN prospects r ON r.id=l.prospect_id WHERE r.program_id=$1 ORDER BY l.created_at DESC`,
      [campaign]
    )
  ).rows.map(({ sealed, ...r }) => ({ ...r, ...ctx.vault.open<LetterBody>(ws, sealed) }));
  const inbox = (
    await ctx.db.query(
      `SELECT i.id,i.kind,i.received_at,i.handled_at,i.letter_id,i.sealed FROM inbound i JOIN letters l ON l.id=i.letter_id JOIN prospects r ON r.id=l.prospect_id WHERE r.program_id=$1 ORDER BY i.received_at DESC LIMIT 200`,
      [campaign]
    )
  ).rows.map(({ sealed, ...r }) => ({ ...r, text: ctx.vault.open<{ text: string }>(ws, sealed).text }));
  return { campaign: p, summary, prospects, runs, events, letters, inbox };
}
export async function dispatchRoute(ctx: Context, url: URL, method: string, b: Input) {
  const [resource, key, action, extra] = url.pathname.slice('/v1/outreach/'.length).split('/');
  if (extra) throw new RequestError(404, 'Unknown endpoint.');
  const ws = ctx.member.workspaceId;
  if (resource === 'skills' && method === 'GET') return installedSkills(key);
  if (resource === 'connectors' && method === 'GET') return installedConnectors();
  if (resource === 'members' && !key) {
    if (method === 'GET')
      return (await ctx.db.query('SELECT id,name,role FROM active_members ORDER BY name')).rows;
    requireRole(ctx);
    if (method === 'POST') {
      const role = field(b.role, 'role');
      if (!['operator', 'reviewer', 'researcher', 'analyst', 'viewer'].includes(role))
        throw new RequestError(422, 'Invalid member role.');
      const token = randomBytes(32).toString('base64url'),
        hash = createHash('sha256').update(token).digest('hex');
      const inserted = await ctx.db.query('SELECT mailoop.invite_member($1,$2,$3) AS id', [
        field(b.name, 'member name'),
        role,
        hash
      ]);
      return { id: inserted.rows[0].id, token };
    }
  }
  if (resource === 'members' && key && method === 'DELETE') {
    requireRole(ctx);
    await ctx.db.query('SELECT mailoop.remove_member($1)', [id(key)]);
    return { ok: true };
  }
  if (resource === 'campaigns') {
    if (!key && method === 'GET') return listPrograms(ctx);
    if (!key && method === 'POST') return newProgram(ctx, b);
    const campaign = id(key);
    if (method === 'GET' && !action) return overview(ctx, campaign);
    if (method === 'GET' && action === 'report')
      return report(
        ctx,
        campaign,
        url.searchParams.get('from'),
        url.searchParams.get('to'),
        url.searchParams
      );
    if (method === 'GET' && action === 'events') {
      await program(ctx, campaign);
      const after = integer(
        Number(url.searchParams.get('after') ?? 0),
        'cursor',
        0,
        Number.MAX_SAFE_INTEGER
      );
      return (
        await ctx.db.query(
          'SELECT seq,type,resource_id,actor_id,at,detail FROM journal WHERE program_id=$1 AND seq>$2 ORDER BY seq LIMIT 100',
          [campaign, after]
        )
      ).rows;
    }
    if (method === 'POST') {
      if (action === 'preview') return preview(ctx, campaign, b);
      if (action === 'apply') return applyImport(ctx, campaign, b);
      if (action === 'approve') return approveBatch(ctx, campaign, b);
      if (action === 'runs') return startRun(ctx, campaign, b);
      if (action === 'status') return changeProgram(ctx, campaign, b);
      if (action === 'share') {
        const p = await program(ctx, campaign);
        if (ctx.member.role !== 'admin' && p.owner_id !== ctx.member.id)
          throw new RequestError(403, 'Campaign owner required.');
        const member = id(b.memberId);
        if (b.remove === true)
          await ctx.db.query('DELETE FROM program_members WHERE program_id=$1 AND member_id=$2', [
            campaign,
            member
          ]);
        else
          await ctx.db.query(
            'INSERT INTO program_members SELECT $1,$2,id FROM active_members WHERE id=$3 ON CONFLICT DO NOTHING',
            [ws, campaign, member]
          );
        return { ok: true };
      }
      if (action === 'brief') {
        requireRole(ctx, 'operator', 'reviewer');
        await lockWorkspace(ctx);
        const p = await program(ctx, campaign);
        if (p.version !== b.version) throw new RequestError(412, 'Brief changed.');
        const facts = Array.isArray(b.facts)
          ? b.facts.map((f) => ({
              text: field(f?.text, 'fact'),
              expiresAt: instant(f?.expiresAt).toISOString()
            }))
          : p.facts;
        await ctx.db.query('UPDATE programs SET brief=$2,facts=$3,version=version+1 WHERE id=$1', [
          campaign,
          field(b.brief, 'brief', 8000),
          JSON.stringify(facts)
        ]);
        await ctx.db.query(
          `UPDATE letters l SET status='held',reason='brief_changed' FROM prospects r WHERE r.id=l.prospect_id AND r.program_id=$1 AND l.status='scheduled'`,
          [campaign]
        );
        return program(ctx, campaign);
      }
    }
  }
  if (resource === 'bindings') {
    if (method === 'POST' && !key) return bindModel(ctx, b);
    if (method === 'GET' && !key)
      return (
        await ctx.db.query('SELECT id,provider,model,active FROM bindings WHERE owner_id=$1', [
          ctx.member.id
        ])
      ).rows;
    if (method === 'DELETE' && key) {
      await ctx.db.query("UPDATE bindings SET active=false,secret='' WHERE id=$1 AND owner_id=$2", [
        id(key),
        ctx.member.id
      ]);
      return { ok: true };
    }
  }
  if (resource === 'runs' && key && method === 'POST') return runAction(ctx, id(key), b);
  if (resource === 'previews' && key && method === 'GET') {
    const row = (
      await ctx.db.query('SELECT id,program_id,digest,decisions,applied_at FROM imports WHERE id=$1', [
        id(key)
      ])
    ).rows[0];
    if (!row) throw new RequestError(404, 'Preview not found.');
    await program(ctx, row.program_id);
    return { ...row, previewId: row.id };
  }
  if (resource === 'mailboxes') {
    if (key && action === 'unmatched' && method === 'GET') return unmatched(ctx, id(key));
    if (key && action === 'bridge' && method === 'POST') {
      const m = (
        await ctx.db.query('SELECT id,version FROM mailboxes WHERE id=$1 AND owner_id=$2 AND active', [
          id(key),
          ctx.member.id
        ])
      ).rows[0];
      if (!m) throw new RequestError(404, 'Owned mailbox not found.');
      return {
        url: ctx.base + '/webhooks/mail/' + ws + '/' + m.id,
        secret: bridgeSecret(ctx.vault, ws, m.id, m.version)
      };
    }
    if (!key && method === 'GET' && ['analyst', 'viewer', 'researcher'].includes(ctx.member.role))
      return [];
    if (!key && method === 'GET')
      return (
        await ctx.db.query(
          `SELECT DISTINCT m.id,m.address,m.provider,m.cap,m.active,m.owner_id,m.synced_at
      FROM mailboxes m WHERE m.owner_id=$1 OR EXISTS(SELECT 1 FROM delegations d JOIN programs p ON p.id=d.program_id
      WHERE d.mailbox_id=m.id AND (p.owner_id=$1 OR $2='admin' OR EXISTS(SELECT 1 FROM program_members a WHERE a.program_id=p.id AND a.member_id=$1)))`,
          [ctx.member.id, ctx.member.role]
        )
      ).rows.map((r) => ({ ...r, address: ctx.vault.open(ws, r.address) }));
    if (method === 'POST' && key === 'connect') return startOAuth(ctx, b);
    if (method === 'POST' && !key) return directMailbox(ctx, b);
    if (method === 'POST' && key && action === 'grant') return grantMailbox(ctx, id(key), b);
  }
  if (method === 'POST' && resource === 'creators' && key) {
    const k = id(key);
    if (action === 'shortlist') {
      requireRole(ctx, 'operator', 'reviewer');
      const r = await prospect(ctx, k);
      if (typeof b.selected !== 'boolean') throw new RequestError(422, 'Choose a shortlist state.');
      await lockWorkspace(ctx);
      await ctx.db.query('UPDATE prospects SET shortlisted=$2 WHERE id=$1', [k, b.selected]);
      await record(ctx.db, ws, r.program_id, 'shortlist.reviewed', k, ctx.member.id, {
        selected: b.selected
      });
      return { selected: b.selected };
    }
    if (action === 'permission') return attest(ctx, k, b);
    if (action === 'drafts') return makeDraft(ctx, k, b);
    if (action === 'outcome') return outcome(ctx, k, b);
    if (action === 'suppress') {
      requireRole(ctx, 'reviewer', 'operator');
      const p = await prospect(ctx, k);
      if (!p.contact_key) throw new RequestError(422, 'No contact point.');
      await suppress(ctx.db, ws, p.contact_key, 'opt_out');
      return { ok: true };
    }
  }
  if (resource === 'letters' && key) {
    const k = id(key);
    if (method === 'PATCH' && !action) return editDraft(ctx, k, b);
    if (method === 'POST' && action === 'cancel') {
      requireRole(ctx, 'operator', 'reviewer');
      await lockWorkspace(ctx);
      const l = await letter(ctx, k);
      if (!['draft', 'scheduled', 'held'].includes(l.status))
        throw new RequestError(409, 'Handoff has already started.');
      await ctx.db.query("UPDATE letters SET status='cancelled' WHERE id=$1", [k]);
      await record(ctx.db, ws, l.program_id, 'dispatch.cancelled', k, ctx.member.id);
      return { ok: true };
    }
    if (method === 'POST' && action === 'simulate') {
      requireRole(ctx, 'reviewer');
      const l = await letter(ctx, k);
      const m = (await ctx.db.query('SELECT provider FROM mailboxes WHERE id=$1', [l.mailbox_id]))
        .rows[0];
      if (m.provider !== 'simulated' || l.status !== 'accepted')
        throw new RequestError(409, 'An accepted simulator message is required.');
      const body = ctx.vault.open<LetterBody>(ws, l.sealed),
        kind = field(b.kind, 'kind');
      if (
        ![
          'reply',
          'quote',
          'interested',
          'auto_reply',
          'opt_out',
          'hard_bounce',
          'complaint',
          'declined'
        ].includes(kind)
      )
        throw new RequestError(422, 'Invalid kind.');
      return ingest(
        ctx.db,
        ws,
        ctx.vault,
        k,
        {
          sourceId: field(b.sourceId, 'source event'),
          from: body.to,
          text: field(b.text, 'reply'),
          references: [messageId(k, body.from)],
          at: new Date().toISOString(),
          auto: kind === 'auto_reply'
        },
        kind
      );
    }
  }
  if (resource === 'inbox' && key && method === 'POST') {
    requireRole(ctx, 'operator', 'reviewer');
    const row = (await ctx.db.query('SELECT * FROM inbound WHERE id=$1', [id(key)])).rows[0];
    if (!row) throw new RequestError(404, 'No such reply.');
    const l = await letter(ctx, row.letter_id);
    if (
      b.kind &&
      !['reply', 'quote', 'interested', 'declined', 'opt_out', 'auto_reply'].includes(String(b.kind))
    )
      throw new RequestError(422, 'Invalid classification.');
    if (b.kind === 'opt_out') await suppress(ctx.db, ws, l.contact_key, 'opt_out');
    await ctx.db.query(
      'UPDATE inbound SET handled_at=coalesce(handled_at,now()),handler_id=coalesce(handler_id,$3),kind=coalesce($2,kind) WHERE id=$1',
      [row.id, b.kind ?? null, ctx.member.id]
    );
    await record(ctx.db, ws, l.program_id, 'inbox.handled', row.id, ctx.member.id);
    return { ok: true };
  }
  throw new RequestError(404, 'Resource not found.');
}
