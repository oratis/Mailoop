import { connector } from '../connectors/sdk.ts';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { nylasOrigin, remoteJSON, type BasicMailbox } from './mailbox-auth.ts';
import { RequestError } from '../db/database.ts';
export type Envelope = {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  unsubscribe: string;
  parent?: string;
  references?: string[];
  parentReceipt?: string;
};
export type MailAccount = { provider: string; token?: string; basic?: BasicMailbox; email: string };
export type InboundMail = {
  sourceId: string;
  rfcMessageId?: string;
  from: string;
  text: string;
  references: string[];
  at: string;
  auto: boolean;
};
export const messageId = (id: string, from: string) => '<' + id + '@' + from.split('@')[1] + '>';
const feishu = 'https://open.feishu.cn/open-apis/mail/v1/user_mailboxes/me';
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const graph = 'https://graph.microsoft.com/v1.0/me';
function imap(b: BasicMailbox) {
  return new ImapFlow({
    host: b.imapHost,
    port: b.imapPort,
    secure: true,
    auth: { user: b.user, pass: b.password },
    logger: false,
    socketTimeout: 18000
  });
}
function smtp(b: BasicMailbox) {
  return nodemailer.createTransport({
    host: b.smtpHost,
    port: b.smtpPort,
    secure: true,
    auth: { user: b.user, pass: b.password },
    connectionTimeout: 15000,
    socketTimeout: 20000
  });
}
export async function verifyBasic(b: BasicMailbox) {
  const s = smtp(b);
  try {
    await s.verify();
  } finally {
    s.close();
  }
  const i = imap(b);
  try {
    await i.connect();
  } finally {
    if (i.usable) await i.logout();
  }
}
export async function mime(e: Envelope) {
  if (
    [e.from, e.to, e.subject, e.parent ?? '', ...(e.references ?? []), e.unsubscribe].some((v) =>
      /[\r\n]/.test(v)
    )
  )
    throw new RequestError(422, 'Invalid mail header.');
  const { message } = await nodemailer
    .createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    .sendMail({
      from: e.from,
      to: e.to,
      subject: e.subject,
      text: e.body + '\n\nUnsubscribe: ' + e.unsubscribe,
      messageId: messageId(e.id, e.from),
      inReplyTo: e.parent,
      references: e.references ?? e.parent,
      headers: {
        'List-Unsubscribe': '<' + e.unsubscribe + '>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    });
  return message as Buffer;
}
const post = (data: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});
function confirmed(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing provider receipt.');
  return value;
}
export class CloudDraft extends RequestError {
  constructor(readonly draftId: string) {
    super(403, 'Feishu mailbox permits cloud drafts only.');
  }
}
export async function submitMail(m: MailAccount, e: Envelope, approved?: Buffer) {
  if (m.provider === 'simulated') return 'sim-' + e.id;
  const raw = approved ?? (await mime(e)),
    token = m.token!;
  if (m.provider === 'nylas') {
    const form = new FormData();
    form.set('mime', raw.toString('utf8'));
    const receipt = await remoteJSON(nylasOrigin() + '/v3/grants/me/messages/send?type=mime', token, {
      method: 'POST',
      body: form
    });
    return confirmed(receipt.data?.id);
  }
  if (m.provider === 'gmail') {
    let threadId: string | undefined;
    if (e.parentReceipt) {
      const parent = await remoteJSON(
        gmail + '/messages/' + encodeURIComponent(e.parentReceipt) + '?format=minimal',
        token
      );
      if (!parent.threadId) throw new RequestError(422, 'Original Gmail thread unavailable.');
      threadId = parent.threadId;
    }
    return confirmed(
      (
        await remoteJSON(
          gmail + '/messages/send',
          token,
          post({ raw: raw.toString('base64url'), threadId })
        )
      ).id
    );
  }
  if (m.provider === 'feishu') {
    const d = await remoteJSON(feishu + '/drafts', token, post({ raw: raw.toString('base64url') }));
    const did = d.data?.draft?.id;
    if (!did) throw new RequestError(422, 'Unable to create Feishu draft.');
    const sent = await remoteJSON(
      feishu + '/drafts/' + encodeURIComponent(did) + '/send',
      token,
      post({})
    );
    if (sent.data?.automation_send_disable) throw new CloudDraft(did);
    return String(sent.data?.message_id ?? did);
  }
  if (m.provider === 'graph') {
    await remoteJSON(graph + '/sendMail', token, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: raw.toString('base64')
    });
    return messageId(e.id, e.from);
  }
  if (m.provider === 'smtp') {
    const s = smtp(m.basic!);
    try {
      const r = await s.sendMail({ envelope: { from: e.from, to: [e.to] }, raw });
      if (!r.accepted.length) throw new RequestError(422, 'SMTP rejected recipient.');
      return messageId(e.id, e.from);
    } finally {
      s.close();
    }
  }
  const ext = connector(m.provider);
  if (ext) return ext.submit(m.basic as unknown as Record<string, unknown>, e, raw);
  throw new RequestError(422, 'Unsupported mailbox.');
}
export async function reconcileMail(m: MailAccount, id: string) {
  const mid = messageId(id, m.email),
    token = m.token!;
  if (m.provider === 'nylas') {
    const api = nylasOrigin() + '/v3/grants/me/messages';
    const query = new URLSearchParams({ from: m.email, limit: '50', fields: 'include_headers' });
    for (let n = 0; n < 10; n++) {
      const page = await remoteJSON(api + '?' + query, token);
      const match = page.data?.find(
        (v: { headers: { name: string; value: string }[] }) => headersOf(v.headers)['message-id'] === mid
      );
      if (match) return confirmed(match.id);
      if (!page.next_cursor) return;
      query.set('page_token', page.next_cursor);
    }
    return;
  }
  if (m.provider === 'gmail') {
    const d = await remoteJSON(
      gmail + '/messages?maxResults=5&q=' + encodeURIComponent('in:sent rfc822msgid:' + mid),
      token
    );
    return d.messages?.[0]?.id as string | undefined;
  }
  if (m.provider === 'graph') {
    const d = await remoteJSON(
      graph +
        '/mailFolders/sentitems/messages?$select=id&$filter=' +
        encodeURIComponent("internetMessageId eq '" + mid.replaceAll("'", "''") + "'"),
      token
    );
    return d.value?.[0]?.id as string | undefined;
  }
  if (m.provider === 'smtp') {
    const c = imap(m.basic!);
    try {
      await c.connect();
      const f = (await c.list()).find((f) => f.specialUse === '\\Sent');
      if (!f) return;
      await c.mailboxOpen(f.path, { readOnly: true });
      const matches = await c.search({ header: { 'message-id': mid } }, { uid: true });
      return matches && matches.length ? mid : undefined;
    } finally {
      if (c.usable) await c.logout();
    }
  }
  if (m.provider === 'feishu') {
    const query = new URLSearchParams({ folder_id: 'SENT', page_size: '20' });
    for (let n = 0; n < 10; n++) {
      const page = await remoteJSON(feishu + '/messages?' + query, token);
      for (const item of page.data?.items ?? []) {
        const key = String(item.id ?? item);
        const d = (
          await remoteJSON(feishu + '/messages/' + encodeURIComponent(key) + '?format=metadata', token)
        ).data?.message;
        if (d?.smtp_message_id?.replace(/[<>]/g, '') === mid.slice(1, -1)) return key;
      }
      if (!page.data?.has_more || !page.data.page_token) return;
      query.set('page_token', page.data.page_token);
    }
  }
  const ext = connector(m.provider);
  if (ext) return ext.reconcile(m.basic as unknown as Record<string, unknown>, mid);
  return undefined;
}
function headersOf(headers: { name: string; value: string }[] = []) {
  return Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]));
}
function references(h: Record<string, string>): string[] {
  return ((h['in-reply-to'] ?? '') + ' ' + (h.references ?? '')).match(/<[^<>]+>/g) ?? [];
}
const emailFrom = (s: string) => s.match(/<([^<>]+)>/)?.[1] ?? s.trim();
export async function readRelated(
  m: MailAccount,
  letter: { id: string; receipt: string; accepted_at: Date; checked_at?: Date; scanUntil?: Date },
  to: string
): Promise<InboundMail[]> {
  const mid = messageId(letter.id, m.email),
    token = m.token!,
    result: InboundMail[] = [];
  if (m.provider === 'simulated') return [];
  if (m.provider === 'nylas') {
    const api = nylasOrigin() + '/v3/grants/me',
      sent = await remoteJSON(api + '/messages/' + encodeURIComponent(letter.receipt), token);
    const thread = (await remoteJSON(api + '/threads/' + encodeURIComponent(sent.data.thread_id), token))
      .data;
    if (thread.message_ids?.length > 100) throw new Error('Thread exceeds scan limit.');
    for (const key of thread.message_ids ?? []) {
      if (key === letter.receipt) continue;
      const v = (
        await remoteJSON(api + '/messages/' + encodeURIComponent(key) + '?fields=include_headers', token)
      ).data;
      const h = headersOf(v.headers),
        refs = references(h);
      if (refs.includes(mid))
        result.push({
          sourceId: key,
          rfcMessageId: h['message-id'],
          from: v.from?.[0]?.email ?? '',
          text: v.snippet ?? '',
          at: new Date(v.date * 1000).toISOString(),
          references: refs,
          auto: !!h['auto-submitted'] && h['auto-submitted'] !== 'no'
        });
    }
  } else if (m.provider === 'gmail') {
    const sent = await remoteJSON(
      gmail + '/messages/' + encodeURIComponent(letter.receipt) + '?format=minimal',
      token
    );
    const thread = await remoteJSON(
      gmail + '/threads/' + encodeURIComponent(sent.threadId) + '?format=full',
      token
    );
    for (const item of thread.messages ?? []) {
      const h = headersOf(item.payload?.headers),
        refs = references(h);
      if (!refs.includes(mid)) continue;
      const part =
        (item.payload?.parts ?? []).find((x: { mimeType: string }) => x.mimeType === 'text/plain') ??
        item.payload;
      result.push({
        sourceId: item.id,
        rfcMessageId: h['message-id'],
        from: emailFrom(h.from ?? ''),
        text: Buffer.from(part?.body?.data ?? '', 'base64url')
          .toString()
          .slice(0, 20000),
        references: refs,
        at: new Date(Number(item.internalDate)).toISOString(),
        auto: !!h['auto-submitted'] && h['auto-submitted'] !== 'no'
      });
    }
  } else if (m.provider === 'graph') {
    const sent = await remoteJSON(
      graph +
        '/mailFolders/sentitems/messages?$select=conversationId&$filter=' +
        encodeURIComponent("internetMessageId eq '" + mid.replaceAll("'", "''") + "'"),
      token
    );
    const conv = sent.value?.[0]?.conversationId;
    if (!conv) throw new Error('Sent thread is not indexed yet.');
    let page =
      graph +
      '/messages?$top=40&$select=id,from,bodyPreview,receivedDateTime,internetMessageHeaders&$filter=' +
      encodeURIComponent("conversationId eq '" + String(conv).replaceAll("'", "''") + "'");
    for (let n = 0; page && n < 10; n++) {
      const d = await remoteJSON(page, token);
      for (const item of d.value ?? []) {
        const h = headersOf(item.internetMessageHeaders),
          refs = references(h);
        if (refs.includes(mid))
          result.push({
            sourceId: item.id,
            rfcMessageId: h['message-id'],
            from: item.from?.emailAddress?.address ?? '',
            text: item.bodyPreview ?? '',
            references: refs,
            at: item.receivedDateTime,
            auto: !!h['auto-submitted'] && h['auto-submitted'] !== 'no'
          });
      }
      page = d['@odata.nextLink'] ?? '';
      if (page && !page.startsWith('https://graph.microsoft.com/'))
        throw new RequestError(502, 'Invalid Graph page cursor.');
    }
    if (page) throw new Error('Thread exceeded Graph scan limit.');
  } else if (m.provider === 'smtp') {
    const c = imap(m.basic!);
    try {
      await c.connect();
      await c.mailboxOpen('INBOX', { readOnly: true });
      const ids = await c.search(
        { or: [{ header: { 'in-reply-to': mid } }, { header: { references: mid } }] },
        { uid: true }
      );
      if (ids && ids.length > 200) throw new Error('Thread exceeds IMAP scan limit.');
      if (ids && ids.length)
        for await (const item of c.fetch(
          ids,
          { source: { start: 0, maxLength: 262144 }, uid: true },
          { uid: true }
        )) {
          if (!item.source) continue;
          const parsed = await simpleParser(item.source);
          const refs = [parsed.inReplyTo, ...[parsed.references ?? []].flat()].filter(
            (s): s is string => !!s
          );
          if (refs.includes(mid))
            result.push({
              rfcMessageId: parsed.messageId,
              sourceId:
                parsed.messageId ?? String(item.uid) + '/' + String(c.mailbox && c.mailbox.uidValidity),
              from: parsed.from?.value[0]?.address ?? '',
              text: (parsed.text ?? '').slice(0, 20000),
              at: (parsed.date ?? new Date()).toISOString(),
              references: refs,
              auto:
                !!parsed.headers.get('auto-submitted') && parsed.headers.get('auto-submitted') !== 'no'
            });
        }
    } finally {
      if (c.usable) await c.logout();
    }
  } else if (m.provider === 'feishu') {
    const since = new Date(
      Math.max(letter.accepted_at.getTime(), (letter.checked_at?.getTime() ?? 0) - 300000)
    );
    const utc = (d: Date) => d.toISOString().slice(0, 19) + 'Z';
    const query = new URLSearchParams({ page_size: '15' });
    for (let page = 0; page < 20; page++) {
      const list = await remoteJSON(
        feishu + '/search?' + query,
        token,
        post({
          filter: {
            folder: ['inbox', 'spam'],
            create_time: { start_time: utc(since), end_time: utc(letter.scanUntil ?? new Date()) }
          }
        })
      );
      for (const row of list.data?.items ?? []) {
        const d = (
          await remoteJSON(
            feishu + '/messages/' + encodeURIComponent(row.id) + '?format=metadata',
            token
          )
        ).data?.message;
        if (!d) continue;
        const refs = references({
          'in-reply-to': String(d.in_reply_to ?? ''),
          references: String(d.references ?? '')
        });
        if (d.in_reply_to === mid.slice(1, -1)) refs.push(mid);
        if (!refs.includes(mid) || (d.head_from?.mail_address ?? '').toLowerCase() !== to.toLowerCase())
          continue;
        const full = (
          await remoteJSON(
            feishu + '/messages/' + encodeURIComponent(row.id) + '?format=plain_text_full',
            token
          )
        ).data?.message;
        result.push({
          sourceId: row.id,
          rfcMessageId: d.smtp_message_id,
          from: d.head_from?.mail_address ?? '',
          text: Buffer.from(full?.body_plain_text ?? '', 'base64url')
            .toString()
            .slice(0, 20000),
          at: new Date(Number(d.internal_date) || Date.now()).toISOString(),
          references: refs,
          auto: /^(automatic reply|out of office|自动回复)/i.test(d.subject ?? '')
        });
      }
      if (!list.data?.has_more) break;
      if (!list.data.page_token || page === 19) throw new Error('Incomplete Feishu page window.');
      query.set('page_token', list.data.page_token);
    }
  }
  const ext = connector(m.provider);
  if (ext)
    result.push(
      ...(await ext.replies(m.basic as unknown as Record<string, unknown>, letter.receipt, mid))
    );
  return result.filter((r) => r.from.toLowerCase() === to.toLowerCase() && r.references.includes(mid));
}
