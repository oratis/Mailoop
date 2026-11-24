import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { asWorkspace, RequestError } from '../db/database.ts';
import { address, field, id, instant, Vault } from './security.ts';
import { type Context, type Input } from './context.ts';
import { ingest } from './delivery.ts';
import { messageId, type InboundMail } from './mail-transports.ts';
import type { LetterBody } from './letters.ts';

export function bridgeSecret(vault: Vault, ws: string, box: string, version: number) {
  return vault.hash(ws, 'mail-events/' + box + '/' + version);
}
export function authenticateEvent(
  secret: string,
  at: string,
  raw: Buffer,
  signature: string,
  now = Date.now()
) {
  const seconds = Number(at);
  if (
    !Number.isInteger(seconds) ||
    Math.abs(now / 1000 - seconds) > 300 ||
    !/^[0-9a-f]{64}$/i.test(signature)
  )
    throw new RequestError(401, 'Expired or invalid webhook.');
  const expected = createHmac('sha256', secret)
    .update(at + '.')
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new RequestError(401, 'Invalid webhook signature.');
}
export async function receiveEvent(
  pool: Pool,
  vault: Vault,
  workspace: string,
  mailboxId: string,
  at: string,
  signature: string,
  raw: Buffer
) {
  const ws = id(workspace),
    box = id(mailboxId);
  return asWorkspace(pool, ws, async (db) => {
    const m = (await db.query('SELECT id,version,active FROM mailboxes WHERE id=$1', [box])).rows[0];
    if (!m?.active) throw new RequestError(404, 'Mailbox unavailable.');
    authenticateEvent(bridgeSecret(vault, ws, box, m.version), at, raw, signature);
    let b: Input;
    try {
      b = JSON.parse(raw.toString());
    } catch {
      throw new RequestError(400, 'Invalid webhook JSON.');
    }
    const eventId = field(b.eventId, 'event ID', 500),
      from = address(b.address),
      received = instant(b.at);
    const kind = field(b.kind, 'kind');
    if (!['reply', 'soft_bounce', 'hard_bounce', 'complaint', 'opt_out', 'auto_reply'].includes(kind))
      throw new RequestError(422, 'Unsupported inbound event.');
    const refs = Array.isArray(b.references)
      ? b.references.slice(0, 30).map((r) => field(r, 'RFC reference', 400))
      : [];
    const ids = refs
      .map((r) => /^<([a-f0-9-]{36})@/i.exec(r)?.[1])
      .filter((v): v is string => !!v)
      .map(id);
    const candidates = (
      await db.query(
        'SELECT id,sealed FROM letters WHERE mailbox_id=$1 AND id=ANY($2::uuid[]) AND attempted_at IS NOT NULL',
        [box, ids]
      )
    ).rows;
    const matches = candidates.filter((l) => {
      const draft = vault.open<LetterBody>(ws, l.sealed);
      return draft.to === from && refs.includes(messageId(l.id, draft.from));
    });
    const event: InboundMail = {
      sourceId: eventId,
      rfcMessageId:
        typeof b.rfcMessageId === 'string' ? field(b.rfcMessageId, 'message ID', 400) : undefined,
      from,
      references: refs,
      at: received.toISOString(),
      auto: kind === 'auto_reply',
      text: typeof b.text === 'string' ? b.text.slice(0, 20000) : ''
    };
    if (matches.length === 1)
      return ingest(db, ws, vault, matches[0].id, event, kind === 'reply' ? undefined : kind);
    // Store only an envelope for the mailbox owner when the thread is ambiguous.
    const { rowCount } = await db.query(
      `INSERT INTO inbound(workspace_id,mailbox_id,source_id,kind,sealed,received_at) VALUES($1,$2,$3,'unmatched',$4,$5)
      ON CONFLICT DO NOTHING`,
      [ws, box, eventId, vault.seal(ws, { ...event, text: '', originalKind: kind }), received]
    );
    return { unmatched: true, duplicate: !rowCount };
  });
}
export async function unmatched(ctx: Context, box: string) {
  if (
    !(await ctx.db.query('SELECT 1 FROM mailboxes WHERE id=$1 AND owner_id=$2', [box, ctx.member.id]))
      .rowCount
  )
    throw new RequestError(404, 'Owned mailbox not found.');
  return (
    await ctx.db.query(
      "SELECT id,sealed,received_at FROM inbound WHERE mailbox_id=$1 AND kind='unmatched' ORDER BY received_at DESC LIMIT 100",
      [box]
    )
  ).rows.map((r) => {
    const e = ctx.vault.open<InboundMail>(ctx.member.workspaceId, r.sealed);
    return { id: r.id, from: e.from, references: e.references, at: r.received_at };
  });
}
