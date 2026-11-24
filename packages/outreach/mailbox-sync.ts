import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { asWorkspace, RequestError } from '../db/database.ts';
import { Vault } from './security.ts';
import { accessMailbox, remoteJSON } from './mailbox-auth.ts';
import type { MailAccount } from './mail-transports.ts';

type Cursor = { history?: string; page?: string; delta?: string };
type ChangePage = { cursor: Cursor; more: boolean; refs: Set<string> };
type Header = { name: string; value: string };
function referenced(headers: Header[], refs: Set<string>) {
  for (const h of headers)
    if (['references', 'in-reply-to'].includes(h.name.toLowerCase()))
      for (const match of h.value.matchAll(/<([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})@[^<>]+>/gi))
        refs.add(match[1].toLowerCase());
}
// Change feeds inspect thread references only. Body retrieval stays in the per-letter reader.
export async function changedThreads(account: MailAccount, prior: Cursor): Promise<ChangePage> {
  const refs = new Set<string>(),
    token = account.token!;
  if (account.provider === 'gmail') {
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
    if (!prior.history) {
      const profile = await remoteJSON(base + '/profile', token);
      if (!profile.historyId) throw Error('Invalid Gmail history cursor.');
      return { cursor: { history: String(profile.historyId) }, more: false, refs };
    }
    const q = new URLSearchParams({
      startHistoryId: prior.history,
      historyTypes: 'messageAdded',
      maxResults: '25'
    });
    if (prior.page) q.set('pageToken', prior.page);
    const data = await remoteJSON(base + '/history?' + q, token);
    for (const record of data.history ?? [])
      for (const { message } of record.messagesAdded ?? []) {
        try {
          const d = await remoteJSON(
            base +
              '/messages/' +
              encodeURIComponent(message.id) +
              '?format=metadata&metadataHeaders=References&metadataHeaders=In-Reply-To',
            token
          );
          referenced(d.payload?.headers ?? [], refs);
        } catch (e) {
          if (!(e instanceof RequestError && e.status === 404)) throw e;
        }
      }
    const more = !!data.nextPageToken,
      cursor = more
        ? { history: prior.history, page: String(data.nextPageToken) }
        : { history: String(data.historyId ?? prior.history) };
    return { cursor, more, refs };
  }
  const initial =
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,internetMessageHeaders&$top=25';
  const url = prior.delta ?? initial;
  if (!url.startsWith('https://graph.microsoft.com/')) throw Error('Invalid Graph delta link.');
  const data = await remoteJSON(url, token);
  for (const row of data.value ?? [])
    if (!row['@removed']) referenced(row.internetMessageHeaders ?? [], refs);
  const delta = data['@odata.nextLink'] ?? data['@odata.deltaLink'];
  if (typeof delta !== 'string' || !delta.startsWith('https://graph.microsoft.com/'))
    throw Error('Invalid Graph delta response.');
  return { cursor: { delta }, more: !!data['@odata.nextLink'], refs };
}
export async function syncTick(pool: Pool, ws: string, vault: Vault) {
  const lease = randomUUID();
  const job = await asWorkspace(pool, ws, async (db) => {
    const {
      rows: [m]
    } =
      await db.query(`SELECT id,cursor,version FROM mailboxes m WHERE active AND provider IN ('gmail','graph') AND next_sync<=now()
      AND EXISTS(SELECT 1 FROM letters l WHERE l.mailbox_id=m.id AND l.status IN ('accepted','unknown'))
      ORDER BY next_sync LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!m) return;
    await db.query(
      "UPDATE mailboxes SET sync_lease=$2,next_sync=now()+interval '4 minutes' WHERE id=$1",
      [m.id, lease]
    );
    try {
      return { account: await accessMailbox(db, vault, ws, m.id), m };
    } catch {
      await db.query("UPDATE mailboxes SET sync_lease=NULL,sync_error='reauth_required' WHERE id=$1", [
        m.id
      ]);
    }
  });
  if (!job) return false;
  let page: ChangePage | undefined, error: string | undefined;
  try {
    page = await changedThreads(job.account, job.m.cursor ? JSON.parse(job.m.cursor) : {});
  } catch (e) {
    error =
      e instanceof RequestError && [404, 410].includes(e.status) ? 'cursor_expired' : 'sync_failed';
  }
  await asWorkspace(pool, ws, async (db) => {
    const current = await db.query(
      'SELECT id FROM mailboxes WHERE id=$1 AND active AND version=$2 AND sync_lease=$3 FOR UPDATE',
      [job.m.id, job.m.version, lease]
    );
    if (!current.rowCount) return;
    if (page) {
      await db.query(
        "UPDATE letters SET due_at=LEAST(due_at,now()),checked_at=NULL WHERE mailbox_id=$1 AND id=ANY($2::uuid[]) AND status IN ('accepted','unknown')",
        [job.m.id, [...page.refs]]
      );
      await db.query(
        "UPDATE mailboxes SET cursor=$2,next_sync=now()+$3*interval '1 second',sync_lease=NULL,sync_error=NULL,synced_at=CASE WHEN $4 THEN synced_at ELSE now() END WHERE id=$1",
        [job.m.id, JSON.stringify(page.cursor), page.more ? 1 : 120, page.more]
      );
    } else {
      if (error === 'cursor_expired') {
        await db.query(
          "UPDATE letters SET checked_at=NULL,due_at=LEAST(due_at,now()) WHERE mailbox_id=$1 AND status IN ('accepted','unknown')",
          [job.m.id]
        );
      }
      await db.query(
        "UPDATE mailboxes SET cursor=CASE WHEN $2='cursor_expired' THEN NULL ELSE cursor END,sync_lease=NULL,sync_error=$2,next_sync=now()+interval '1 minute' WHERE id=$1",
        [job.m.id, error]
      );
    }
  });
  return true;
}
