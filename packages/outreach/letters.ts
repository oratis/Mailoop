import { recordUsage } from './metering.ts';
import type { PoolClient } from 'pg';
import { RequestError } from '../db/database.ts';
import { type Context, type Input, lockWorkspace, program, record, requireRole } from './context.ts';
import { type Candidate, prospect } from './imports.ts';
import { address, field, id, instant } from './security.ts';
import { generate } from './models.ts';
import { createHash } from 'node:crypto';
import { messageId, mime } from './mail-transports.ts';
export type LetterBody = {
  from: string;
  to: string;
  subject: string;
  body: string;
  parent?: string;
  references?: string[];
  parentReceipt?: string;
};
export async function letter(ctx: Context, letterId: string) {
  const l = (
    await ctx.db.query(
      'SELECT l.*,p.program_id,p.contact_key FROM letters l JOIN prospects p ON p.id=l.prospect_id WHERE l.id=$1',
      [letterId]
    )
  ).rows[0];
  if (!l) throw new RequestError(404, 'Message not found.');
  await program(ctx, l.program_id);
  return l;
}
function validateContent(subject: unknown, text: unknown) {
  const s = field(subject, 'subject', 200),
    body = field(text, 'body', 16000);
  if (/[\r\n]/.test(s) || /\{\{[^}]+\}\}/.test(body + s))
    throw new RequestError(422, 'Remove header line breaks and unresolved placeholders.');
  return { subject: s, body };
}
export async function makeDraft(ctx: Context, prospectId: string, b: Input) {
  requireRole(ctx, 'operator', 'reviewer');
  const r = await prospect(ctx, prospectId),
    p = await program(ctx, r.program_id);
  const c = ctx.vault.open<Candidate>(ctx.member.workspaceId, r.sealed),
    contact = c.contacts[0];
  if (!contact) throw new RequestError(422, 'No contact point.');
  const step = String(b.step ?? 'first');
  if (!['first', 'followup', 'reply'].includes(step))
    throw new RequestError(422, 'Invalid sequence step.');
  let parent, mailboxId: string;
  if (step === 'first') mailboxId = id(b.mailboxId);
  else {
    parent = await letter(ctx, id(b.parentId));
    if (parent.prospect_id !== r.id || !parent.accepted_at)
      throw new RequestError(409, 'Choose an accepted message from this creator.');
    mailboxId = parent.mailbox_id;
  }
  const {
    rows: [m]
  } = await ctx.db.query(
    `SELECT m.* FROM mailboxes m JOIN delegations d ON m.id=d.mailbox_id JOIN active_members a ON a.id=m.owner_id
    WHERE m.id=$1 AND d.program_id=$2 AND d.expires_at>now() AND m.active`,
    [mailboxId, p.id]
  );
  if (!m) throw new RequestError(403, 'No active mailbox delegation for this campaign.');
  const from = ctx.vault.open<string>(ctx.member.workspaceId, m.address);
  let content;
  if (b.bindingId) {
    const {
      rows: [binding]
    } = await ctx.db.query('SELECT * FROM bindings WHERE id=$1 AND owner_id=$2 AND active', [
      id(b.bindingId),
      ctx.member.id
    ]);
    if (!binding) throw new RequestError(404, 'Model binding not found.');
    const out = await generate(
      binding.provider,
      binding.model,
      ctx.vault.open(ctx.member.workspaceId, binding.secret),
      'Draft a concise creator partnership email. Return JSON {subject,body}. Use only the provided facts and cited work. Do not invent claims, quotes or prices.',
      JSON.stringify({
        brief: p.brief,
        language: c.language,
        work: c.work,
        creator: c.displayName,
        facts: p.facts,
        step
      })
    );
    const invocation = (
      await ctx.db.query(
        "INSERT INTO usage_facts(workspace_id,program_id,id,kind,provider,rates) VALUES($1,$2,gen_random_uuid(),'compose',$3,$4) RETURNING id",
        [ctx.member.workspaceId, p.id, binding.provider, binding.rates]
      )
    ).rows[0].id;
    await recordUsage(ctx.db, ctx.member.workspaceId, invocation, out.usage, binding.rates);
    content = validateContent(out.value?.subject, out.value?.body);
  } else content = validateContent(b.subject, b.body);
  let thread: Pick<LetterBody, 'parent' | 'references' | 'parentReceipt'> = {};
  if (parent) {
    const anchor = messageId(parent.id, from),
      original = ctx.vault.open<LetterBody>(ctx.member.workspaceId, parent.sealed);
    thread = { parent: anchor, references: [anchor], parentReceipt: parent.receipt };
    if (step === 'reply') {
      const inbound = (
        await ctx.db.query(
          "SELECT sealed FROM inbound WHERE letter_id=$1 AND kind NOT IN ('hard_bounce','soft_bounce','complaint','auto_reply') ORDER BY received_at DESC LIMIT 1",
          [parent.id]
        )
      ).rows[0];
      if (!inbound) throw new RequestError(409, 'No human reply in this thread.');
      const ref = ctx.vault.open<{ rfcMessageId?: string }>(
        ctx.member.workspaceId,
        inbound.sealed
      ).rfcMessageId;
      if (ref && /^<[^<>\s]+@[^<>\s]+>$/.test(ref)) {
        thread.parent = ref;
        thread.references = [anchor, ref];
      }
    }
    content.subject = /^re:/i.test(original.subject) ? original.subject : 'Re: ' + original.subject;
  }
  const body: LetterBody = {
    ...content,
    from,
    to: address(contact.address),
    ...thread
  };
  const {
    rows: [l]
  } = await ctx.db.query(
    `INSERT INTO letters(workspace_id,prospect_id,mailbox_id,step,parent_id,sealed,template_version) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING RETURNING id,revision,status`,
    [
      ctx.member.workspaceId,
      r.id,
      m.id,
      step,
      parent?.id ?? null,
      ctx.vault.seal(ctx.member.workspaceId, body),
      field(b.templateVersion ?? (b.bindingId ? 'model' : 'manual'), 'template version', 100)
    ]
  );
  if (!l) throw new RequestError(409, 'This creator already has this sequence step.');
  await record(ctx.db, ctx.member.workspaceId, p.id, 'draft.created', l.id, ctx.member.id);
  return { ...l, ...body };
}
export async function editDraft(ctx: Context, letterId: string, b: Input) {
  requireRole(ctx, 'operator', 'reviewer');
  await lockWorkspace(ctx);
  const l = await letter(ctx, letterId);
  if (l.revision !== b.revision || !['draft', 'held', 'scheduled'].includes(l.status))
    throw new RequestError(412, 'Review the current message revision.');
  await ctx.db.query(
    'INSERT INTO draft_history(workspace_id,letter_id,revision,sealed) VALUES($1,$2,$3,$4)',
    [ctx.member.workspaceId, l.id, l.revision, l.sealed]
  );
  const content = {
    ...ctx.vault.open<LetterBody>(ctx.member.workspaceId, l.sealed),
    ...validateContent(b.subject, b.body)
  };
  const {
    rows: [updated]
  } = await ctx.db.query(
    "UPDATE letters SET sealed=$2,revision=gen_random_uuid(),approved_mime=NULL,approved_digest=NULL,approved_by=NULL,status='draft',reason=NULL WHERE id=$1 RETURNING id,status,revision",
    [l.id, ctx.vault.seal(ctx.member.workspaceId, content)]
  );
  await record(
    ctx.db,
    ctx.member.workspaceId,
    l.program_id,
    'approval.invalidated',
    l.id,
    ctx.member.id
  );
  return updated;
}
export async function gates(db: PoolClient, letterId: string) {
  const {
    rows: [v]
  } = await db.query(
    `SELECT l.*,r.contact_key,(r.evidence_ok AND r.evidence_until>now()) AS evidence_ok,r.shortlisted,r.program_id,p.status AS campaign_state,p.facts,p.version AS current_program_version,
    p.cap AS campaign_cap,p.timezone,p.window_start,p.window_end,m.cap AS mailbox_cap,m.sync_error,m.provider,m.version AS current_mailbox_version,m.active,
    EXISTS(SELECT 1 FROM active_members a WHERE a.id=m.owner_id) AS owner_active,
    EXISTS(SELECT 1 FROM active_members a WHERE a.id=l.approved_by AND a.role IN ('reviewer','admin') AND (a.role='admin' OR p.owner_id=a.id OR EXISTS(SELECT 1 FROM program_members pm WHERE pm.program_id=p.id AND pm.member_id=a.id))) AS reviewer_active,
    EXISTS(SELECT 1 FROM delegations d WHERE d.mailbox_id=m.id AND d.program_id=p.id AND d.expires_at>now()) AS delegated,
    EXISTS(SELECT 1 FROM consents c WHERE c.contact_key=r.contact_key AND c.purpose=p.purpose AND c.region=p.region AND c.expires_at>now()) AS consent,
    EXISTS(SELECT 1 FROM suppressions s WHERE s.contact_key=r.contact_key) AS suppressed,
    EXISTS(SELECT 1 FROM letters x JOIN prospects y ON y.id=x.prospect_id WHERE x.id<>l.id AND x.step='first' AND y.contact_key=r.contact_key AND
      (x.status IN ('scheduled','submitting','unknown') OR x.accepted_at>now()-interval '30 days')) AS cooldown,
    EXISTS(SELECT 1 FROM letters parent WHERE parent.id=l.parent_id AND parent.checked_at>now()-interval '10 minutes') AS recently_checked,
    EXISTS(SELECT 1 FROM inbound i JOIN letters x ON x.id=i.letter_id WHERE x.prospect_id=r.id AND i.kind NOT IN ('auto_reply','soft_bounce')) AS inbound_seen
    FROM letters l JOIN prospects r ON r.id=l.prospect_id JOIN programs p ON p.id=r.program_id JOIN mailboxes m ON m.id=l.mailbox_id WHERE l.id=$1`,
    [letterId]
  );
  if (!v) throw new RequestError(404, 'Message not found.');
  let reason: string | null = null;
  if (v.campaign_state !== 'active') reason = 'campaign_paused';
  else if (v.suppressed) reason = 'suppressed';
  else if (!v.shortlisted || !v.evidence_ok || !v.consent) reason = 'missing_permission';
  else if (!v.owner_active || !v.delegated || !v.active) reason = 'mailbox_revoked';
  else if (
    v.approved_by &&
    (!v.reviewer_active ||
      v.program_version !== v.current_program_version ||
      v.mailbox_version !== v.current_mailbox_version)
  )
    reason = 'approval_expired';
  else if (v.facts.some((f: { expiresAt: string }) => Date.parse(f.expiresAt) <= Date.now()))
    reason = 'fact_expired';
  else if (v.step === 'first' && v.cooldown) reason = 'contact_cooldown';
  else if (v.step === 'followup' && v.inbound_seen) reason = 'reply_received';
  else if (v.step === 'followup' && (!v.recently_checked || v.sync_error)) reason = 'sync_required';
  else if (v.step === 'reply' && !v.inbound_seen) reason = 'no_inbound_thread';
  return { row: v, reason };
}
export async function approveBatch(ctx: Context, campaign: string, b: Input) {
  requireRole(ctx, 'reviewer');
  await lockWorkspace(ctx);
  await program(ctx, campaign);
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100)
    throw new RequestError(422, 'Select 1–100 revisions.');
  const result = [];
  for (const item of b.items) {
    const l = await letter(ctx, id(item?.id));
    if (l.program_id !== campaign || l.revision !== item.revision)
      throw new RequestError(409, 'Revision or campaign changed.');
    if (l.approved_by && ['scheduled', 'submitting', 'unknown', 'accepted'].includes(l.status)) {
      result.push(l.id);
      continue;
    }
    if (!['held', 'draft'].includes(l.status))
      throw new RequestError(409, 'Message cannot be approved.');
    if (l.status === 'held')
      await ctx.db.query('UPDATE letters SET approved_by=NULL WHERE id=$1', [l.id]);
    const { row, reason } = await gates(ctx.db, l.id);
    if (reason && reason !== 'sync_required') throw new RequestError(409, reason);
    const ws = ctx.member.workspaceId,
      body = ctx.vault.open<LetterBody>(ws, l.sealed);
    const envelope = {
      ...body,
      id: l.id,
      unsubscribe:
        ctx.base + '/unsubscribe/' + ctx.vault.token('unsubscribe', ws + '/' + row.contact_key)
    };
    const raw = await mime(envelope),
      digest = createHash('sha256').update(raw).digest('hex');
    await ctx.db.query(
      `UPDATE letters SET approved_mime=$6,approved_digest=$7,approved_by=$2,program_version=$3,mailbox_version=$4,due_at=$5,status='scheduled',reason=NULL WHERE id=$1`,
      [
        l.id,
        ctx.member.id,
        row.current_program_version,
        row.current_mailbox_version,
        item.dueAt ? instant(item.dueAt) : new Date(),
        ctx.vault.seal(ws, { unsubscribe: envelope.unsubscribe, raw: raw.toString('base64') }),
        digest
      ]
    );
    await record(ctx.db, ctx.member.workspaceId, campaign, 'approval.granted', l.id, ctx.member.id, {
      revision: l.revision,
      digest,
      mailboxId: l.mailbox_id
    });
    result.push(l.id);
  }
  return { ids: result };
}
export async function suppress(db: PoolClient, ws: string, key: string, reason: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ws]);
  await db.query(
    'INSERT INTO suppressions(workspace_id,contact_key,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ws, key, reason]
  );
  await db.query(
    `UPDATE letters l SET status='cancelled',reason='suppressed' FROM prospects p
    WHERE l.prospect_id=p.id AND p.contact_key=$1 AND l.status IN ('scheduled','held','draft')`,
    [key]
  );
}
