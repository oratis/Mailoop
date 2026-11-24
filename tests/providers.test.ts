import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startLocalPostgres } from '../scripts/local-postgres.ts';
import { asMember, asWorkspace, seedWorkspace } from '../packages/db/database.ts';
import { Vault } from '../packages/outreach/security.ts';
import {
  accessMailbox,
  oauthCallback,
  startOAuth,
  MailboxError,
  remoteJSON
} from '../packages/outreach/mailbox-auth.ts';
import {
  messageId,
  readRelated,
  reconcileMail,
  submitMail
} from '../packages/outreach/mail-transports.ts';
import { verifyEvidence } from '../packages/outreach/verify-evidence.ts';
import { artifact, type Artifact } from '../packages/outreach/imports.ts';
import { readFile } from 'node:fs/promises';
import { streamedText } from '../apps/plan.ts';

const base = 'https://mailoop.example',
  sender = 'member@brand.example',
  recipient = 'team@creator.example';
const mail = {
  id: 'a297b733-48fc-4fc5-b3dd-5a2615df4387',
  from: sender,
  to: recipient,
  subject: '合作',
  body: '合作邀请',
  unsubscribe: base + '/unsubscribe/test'
};
const rfc = messageId(mail.id, sender);
const json = (data: unknown) => Response.json(data);
test('native OAuth binds the verified member, rejects replay and persists token rotation for every configured identity', async (t) => {
  const db = await startLocalPostgres(),
    v = new Vault(randomBytes(32));
  try {
    for (const provider of ['gmail', 'graph', 'feishu', 'nylas']) {
      process.env['MAILOOP_' + provider.toUpperCase() + '_CLIENT_ID'] = 'test-client';
      process.env['MAILOOP_' + provider.toUpperCase() + '_CLIENT_SECRET'] = 'test-client-secret';
      const w = await seedWorkspace(db.pool, provider, 'admin');
      const result = await asMember(db.pool, w.token, (db, member) =>
        startOAuth({ db, member, vault: v, base }, { provider })
      );
      const auth = new URL(result.url),
        state = auth.searchParams.get('state')!;
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(auth.searchParams.get('redirect_uri'), base + '/oauth/' + provider + '/callback');
      let exchanges = 0;
      const mock = t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('token')) {
          exchanges++;
          assert.ok(init?.body);
          return json({
            access_token: 'rotated-' + exchanges,
            refresh_token: 'refresh-test',
            expires_in: exchanges === 1 ? 1 : 3600,
            grant_id: 'nylas-id',
            email: sender
          });
        }
        if (url.includes('userinfo'))
          return json({ sub: 'google-id', email: sender, email_verified: true });
        if (url.includes('graph.microsoft.com')) return json({ id: 'ms-id', mail: sender });
        if (url.endsWith('/user_info'))
          return json({ code: 0, data: { open_id: 'fs-id', enterprise_email: sender } });
        if (url.endsWith('send_as'))
          return json({ code: 0, data: { sendable_addresses: [{ email_address: sender }] } });
        throw Error('Unexpected provider request');
      });
      try {
        const m = await oauthCallback(db.pool, v, base, provider, state, 'code');
        await assert.rejects(oauthCallback(db.pool, v, base, provider, state, 'code'), /already used/);
        const granted = await asWorkspace(db.pool, w.workspaceId, (client) =>
          accessMailbox(client, v, w.workspaceId, m.id)
        );
        assert.equal(granted.email, sender);
        assert.equal(granted.token, 'rotated-2');
        assert.equal(exchanges, 2);
      } finally {
        mock.mock.restore();
      }
    }
  } finally {
    await db.close();
  }
});
test('mail adapters enforce provider receipts, preserve MIME and discriminate rate limits from uncertain acceptance', async (t) => {
  let path = '',
    calls = 0;
  const mock = t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    path = String(input);
    calls++;
    if (path.includes('gmail')) {
      assert.ok(JSON.parse(String(init?.body)).raw);
      return json({ id: 'gmail-id' });
    }
    if (path.includes('graph.microsoft')) {
      assert.match(Buffer.from(String(init?.body), 'base64').toString(), /List-Unsubscribe-Post/);
      return new Response(null, { status: 202 });
    }
    if (path.endsWith('/drafts')) return json({ code: 0, data: { draft: { id: 'draft-id' } } });
    if (path.endsWith('/draft-id/send'))
      return json({ code: 0, data: { automation_send_disable: true } });
    if (path.includes('nylas')) {
      assert.ok(init?.body instanceof FormData);
      return json({ data: { id: 'hosted-id' } });
    }
    throw Error('Unexpected request');
  });
  const account = (provider: string) => ({ provider, email: sender, token: 'test' });
  assert.equal(await submitMail(account('gmail'), mail), 'gmail-id');
  assert.equal(await submitMail(account('graph'), mail), rfc);
  assert.equal(await submitMail(account('nylas'), mail), 'hosted-id');
  await assert.rejects(submitMail(account('feishu'), mail), /cloud drafts/);
  assert.equal(calls, 5);
  mock.mock.mockImplementation(async () => json({}));
  await assert.rejects(submitMail(account('gmail'), mail), /receipt/);
  mock.mock.mockImplementation(
    async () => new Response(null, { status: 429, headers: { 'Retry-After': '600' } })
  );
  await assert.rejects(
    remoteJSON('https://provider.example', 'test'),
    (e: unknown) => e instanceof MailboxError && e.retryAfterMs === 600000
  );
});
test('Feishu checks every results page and matches the sender before loading bodies, Nylas reconciles by the exact RFC id', async (t) => {
  const pages: string[] = [];
  const mock = t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    const u = new URL(String(input));
    pages.push(u.href);
    if (u.pathname.endsWith('/search'))
      return json({
        code: 0,
        data: u.searchParams.has('page_token')
          ? { items: [{ id: 'reply' }] }
          : { items: [{ id: 'other' }], has_more: true, page_token: 'next' }
      });
    if (u.pathname.endsWith('/other'))
      return json({
        code: 0,
        data: { message: { head_from: { mail_address: 'private@different.example' }, in_reply_to: rfc } }
      });
    if (u.searchParams.get('format') === 'metadata')
      return json({
        code: 0,
        data: {
          message: {
            head_from: { mail_address: recipient },
            in_reply_to: rfc,
            internal_date: Date.now()
          }
        }
      });
    return json({
      code: 0,
      data: { message: { body_plain_text: Buffer.from('Interested').toString('base64url') } }
    });
  });
  const out = await readRelated(
    { provider: 'feishu', email: sender, token: 'test' },
    { id: mail.id, receipt: 'sent', accepted_at: new Date() },
    recipient
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Interested');
  assert.equal(pages.length, 5);
  mock.mock.mockImplementation(async () =>
    json({ data: [{ id: 'correct', headers: [{ name: 'Message-Id', value: rfc }] }] })
  );
  assert.equal(
    await reconcileMail({ email: sender, provider: 'nylas', token: 'test' }, mail.id),
    'correct'
  );
});
test('source checks ground a misattributed citation, withhold invented contact details and reject incomplete plan inference', async () => {
  const sample: Artifact = artifact(
      JSON.parse(
        await readFile(new URL('../docs/examples/research-result.json', import.meta.url), 'utf8')
      )
    ),
    url = base + '/partners';
  const result = verifyEvidence(sample, [
    { url, text: sample.candidates[0].contacts[0].evidenceExcerpt! }
  ]);
  assert.equal(result.candidates[0].contacts[0].evidenceUrl, url);
  assert.deepEqual(verifyEvidence(sample, []).candidates[0].contacts, []);
  assert.throws(
    () => streamedText('data: {"type":"response.output_text.delta","delta":"{}"}'),
    /Incomplete/
  );
  assert.equal(
    streamedText(
      'data: {"type":"response.output_text.delta","delta":"{}"}\ndata: {"type":"response.completed"}'
    ),
    '{}'
  );
});
