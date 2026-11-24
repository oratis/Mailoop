import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { startLocalPostgres } from '../scripts/local-postgres.ts';
import { seedWorkspace, initializeDemoDatabase, asWorkspace } from '../packages/db/database.ts';
import { createApi } from '../apps/api.ts';
import { Vault } from '../packages/outreach/security.ts';
import { deliveryTick } from '../packages/outreach/delivery.ts';
import { messageId, mime } from '../packages/outreach/mail-transports.ts';
import { simpleParser } from 'mailparser';
import { publicAddress } from '../packages/outreach/sources.ts';
let env: Awaited<ReturnType<typeof startLocalPostgres>>,
  server: ReturnType<typeof createApi>,
  base: string;
const vault = new Vault(randomBytes(32));
before(async () => {
  env = await startLocalPostgres();
  await initializeDemoDatabase(env.pool);
  const settings = { vault, base: '', allowReal: false, defaultWorkspace: true };
  server = createApi(env.pool, settings).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  settings.base = base;
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (env) await env.close();
});
function client(token: string) {
  return async function api(
    path: string,
    b?: unknown,
    status = 200,
    method = b === undefined ? 'GET' : 'POST'
  ) {
    const response = await fetch(base + '/v1/outreach/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b)
    });
    const data = await response.json();
    assert.equal(response.status, status, method + ' ' + path + ' ' + JSON.stringify(data));
    return data;
  };
}
function candidate(n: number, contact = true) {
  const url = 'https://studio' + n + '.example';
  const email = 'studio' + n + '@creator.example';
  return {
    displayName: 'Studio ' + n,
    language: 'ja',
    channelUrl: url,
    matchReason: 'Coffee tutorial',
    work: { url: url + '/work', publishedOn: '2026-11-01' },
    contacts: contact
      ? [
          {
            source: 'public_business_page',
            address: email,
            evidenceUrl: url + '/contact',
            evidenceExcerpt: 'Partnerships: ' + email,
            observedAt: new Date().toISOString()
          }
        ]
      : [],
    ...(!contact && { missingReason: 'not_published' })
  };
}
async function setup() {
  const owner = await seedWorkspace(env.pool, 'Outreach test', 'admin'),
    api = client(owner.token);
  const p = await api('campaigns', {
    name: 'Coffee',
    brief: 'Find Japanese coffee creators',
    purpose: 'Partnership',
    region: 'JP'
  });
  return { owner, api, p, route: 'campaigns/' + p.id };
}
const future = () => new Date(Date.now() + 86400000).toISOString();
test('12-row walkthrough, two member identities, atomic batch approval, reconciliation, suppression and 14-day report', async () => {
  const { owner, api, p, route } = await setup();
  const team = await api('members', { name: 'Member B', role: 'reviewer' }),
    bApi = client(team.token);
  await bApi(route, undefined, 404);
  await api(route + '/share', { memberId: team.id });
  const m1 = await api('mailboxes', { provider: 'simulated', address: 'alice@sender.example' }),
    m2 = await bApi('mailboxes', {
      provider: 'simulated',
      address: 'bob@sender.example',
      loseReceipt: true
    });
  for (const [sender, box] of [
    [api, m1],
    [bApi, m2]
  ] as const)
    await sender('mailboxes/' + box.id + '/grant', { campaignId: p.id, expiresAt: future() });
  const candidates = Array.from({ length: 10 }, (_, i) => candidate(i, i < 8));
  candidates.push(candidates[0], candidates[1]);
  const a = {
    schemaVersion: 1,
    briefRevision: '1',
    runId: 'research-walkthrough',
    researchedAt: new Date().toISOString(),
    candidates
  };
  const preview = await api(route + '/preview', a);
  assert.deepEqual(preview.decisions.slice(-4), [
    'missing_evidence',
    'missing_evidence',
    'duplicate',
    'duplicate'
  ]);
  await api(route + '/apply', preview);
  await api(route + '/apply', preview);
  await api(route + '/preview', { ...a, candidates: [] }, 409);
  const creators = (await api(route)).prospects;
  assert.equal(creators.length, 10);
  const ls = [];
  for (const [i, c] of creators
    .filter((c: { contacts: unknown[] }) => c.contacts.length)
    .slice(0, 6)
    .entries()) {
    await api('creators/' + c.id + '/permission', {
      confirmed: true,
      proof: 'Recorded synthetic opt-in ' + i,
      expiresAt: future()
    });
    const l = await api('creators/' + c.id + '/drafts', {
      mailboxId: i < 3 ? m1.id : m2.id,
      subject: 'Coffee',
      body: 'A collaboration invitation'
    });
    ls.push(l);
  }
  const items = ls.map((l) => ({ id: l.id, revision: l.revision }));
  await api(route + '/approve', { items: [items[0], { ...items[1], revision: 'stale' }] }, 409);
  assert.ok((await api(route)).letters.every((l: { status: string }) => l.status === 'draft'));
  await Promise.all([api(route + '/approve', { items }), api(route + '/approve', { items })]);
  for (let i = 0; i < 9; i++) await deliveryTick(env.pool, owner.workspaceId, vault, base, false);
  const partial = (await api(route)).letters;
  assert.equal(partial.filter((l: { status: string }) => l.status === 'unknown').length, 3);
  for (const l of ls.slice(3, 5)) {
    await env.pool.query("UPDATE mailoop.letters SET due_at=now()-interval '1 second' WHERE id=$1", [
      l.id
    ]);
    await deliveryTick(env.pool, owner.workspaceId, vault, base, false);
  }
  const accepted = (await api(route)).letters.filter((l: { status: string }) => l.status === 'accepted');
  assert.equal(accepted.length, 5);
  for (const [i, kind] of ['interested', 'reply', 'hard_bounce'].entries()) {
    const event = { sourceId: 'event' + i, text: 'Synthetic response', kind };
    await api('letters/' + accepted[i].id + '/simulate', event);
    assert.equal((await api('letters/' + accepted[i].id + '/simulate', event)).duplicate, true);
  }
  const key = vault.hash(owner.workspaceId, accepted[3].to),
    link = base + '/unsubscribe/' + vault.token('unsubscribe', owner.workspaceId + '/' + key);
  assert.equal((await fetch(link)).status, 200);
  assert.equal((await fetch(link, { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status, 200);
  const stats = await api(route + '/report');
  assert.deepEqual(stats.reply, { numerator: 2, denominator: 5, rate: 0.4 });
  assert.equal(stats.interest.rate, 0.2);
  assert.equal(stats.unsubscribe.rate, 0.2);
  assert.equal(stats.hardBounce.rate, 0.2);
  const f = await api('creators/' + accepted[0].prospect_id + '/drafts', {
    step: 'followup',
    parentId: accepted[0].id,
    subject: 'Following up',
    body: 'Hello'
  });
  await api(route + '/approve', { items: [f] }, 409);
  const another = await seedWorkspace(env.pool, 'Another', 'admin');
  await client(another.token)(route, undefined, 404);
  const stats2 = await api(route + '/report');
  assert.deepEqual(stats2.reply, stats.reply);
  const logs = await api(route + '/events?after=1');
  assert.ok(logs.every((e: { seq: string }) => Number(e.seq) > 1));
  assert.ok(!JSON.stringify(logs).includes('@creator.example'));
});
test('local host tickets, role checks, stale import detection, lost binding and membership revocation', async () => {
  const { api, p, route } = await setup();
  const researcher = await api('members', { name: 'R', role: 'researcher' }),
    r = client(researcher.token);
  await api(route + '/share', { memberId: researcher.id });
  const bind = await r('bindings', { provider: 'local-artifact', model: 'mailoop-research' });
  const config = { bindingId: bind.id, requestKey: 'local-run', budget: 1 };
  const run = await r(route + '/runs', config);
  assert.equal((await r(route + '/runs', config)).id, run.id);
  await r(route + '/runs', { ...config, budget: 2 }, 409);
  const claim = await r('runs/' + run.id, { action: 'claim' });
  await r('runs/' + run.id, { action: 'claim' }, 409);
  const a = {
    schemaVersion: 1,
    runId: run.id,
    briefRevision: '1',
    researchedAt: new Date().toISOString(),
    candidates: [candidate(99)]
  };
  await r('runs/' + run.id, { action: 'submit', ticket: 'wrong', artifact: a }, 409);
  await r(route + '/preview', { ...a, candidates: [{ ...candidate(99), permission: true }] }, 422);
  const prev = await r('runs/' + run.id, { action: 'submit', ticket: claim.ticket, artifact: a });
  const other = await r(route + '/preview', { ...a, runId: 'another-run' });
  await r(route + '/apply', prev);
  await r(route + '/apply', other, 409);
  const updated = await r(route + '/preview', { ...a, runId: 'another-run' });
  assert.deepEqual(updated.decisions, ['duplicate']);
  const creator = (await r(route)).prospects[0];
  await r(
    'creators/' + creator.id + '/permission',
    { confirmed: true, proof: 'forged', expiresAt: future() },
    403
  );
  await api('members/' + researcher.id, undefined, 200, 'DELETE');
  await r('campaigns', undefined, 401);
  assert.equal(p.id, (await api(route)).campaign.id);
});
test('external adapters use bounded public sources and construct valid unsubscribe and reply headers', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  const raw = await mime({
    id: 'abc',
    from: 'operator@brand.example',
    to: 'creator@studio.example',
    subject: '合作邀请',
    body: '合作？',
    unsubscribe: 'https://brand.example/unsubscribe/demo',
    parent: '<parent@brand.example>'
  });
  const msg = await simpleParser(raw);
  assert.equal(msg.subject, '合作邀请');
  assert.equal(msg.inReplyTo, '<parent@brand.example>');
  assert.equal(msg.messageId, messageId('abc', 'operator@brand.example'));
  assert.ok(raw.toString().includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
});
test('changing the contact invalidates drafts, channel merge is explicit, and erasure clears evidence and history', async () => {
  const { owner, api, route, p } = await setup(),
    first = candidate(22),
    second = candidate(23);
  first.contacts.push({
    ...first.contacts[0],
    address: 'agency@artist.example',
    evidenceExcerpt: 'Business inquiries: agency@artist.example'
  });
  const a = {
    schemaVersion: 1,
    runId: 'multi-channel',
    briefRevision: '1',
    researchedAt: new Date().toISOString(),
    candidates: [first, second]
  };
  await api(route + '/apply', await api(route + '/preview', a));
  const rows = (await api(route)).prospects,
    creator = rows.find((c: { displayName: string }) => c.displayName === first.displayName),
    other = rows.find((c: { id: string }) => c.id !== creator.id);
  await api('creators/' + creator.id + '/merge', { duplicateId: other.id });
  assert.equal((await api(route)).prospects.length, 1);
  assert.deepEqual((await api(route + '/preview', { ...a, runId: 'check-alias' })).decisions, [
    'duplicate',
    'duplicate'
  ]);
  const box = await api('mailboxes', { provider: 'simulated', address: 'review@brand.example' });
  await api('mailboxes/' + box.id + '/grant', { campaignId: p.id, expiresAt: future() });
  const endpoint = 'creators/' + creator.id;
  await api(endpoint + '/permission', {
    confirmed: true,
    proof: 'Synthetic proof',
    expiresAt: future()
  });
  const l = await api(endpoint + '/drafts', { mailboxId: box.id, subject: 'First', body: 'Draft' });
  const edited = await api(
    'letters/' + l.id,
    { revision: l.revision, subject: 'Second', body: 'Edited' },
    200,
    'PATCH'
  );
  assert.equal((await api('letters/' + l.id + '/history'))[0].subject, 'First');
  await api(route + '/approve', { items: [edited] });
  const approved = (
    await env.pool.query('SELECT approved_digest,approved_mime FROM mailoop.letters WHERE id=$1', [l.id])
  ).rows[0];
  assert.equal(approved.approved_digest.length, 64);
  assert.ok(approved.approved_mime);
  await api(endpoint + '/contact', { index: 1 });
  assert.equal((await api(route)).letters[0].status, 'cancelled');
  await api(endpoint, undefined, 200, 'DELETE');
  assert.equal((await api(route)).prospects[0].displayName, 'Removed creator');
  assert.deepEqual(await api('letters/' + l.id + '/history'), []);
  assert.equal(
    (
      await env.pool.query(
        "SELECT count(*)::int AS n FROM mailoop.imports WHERE workspace_id=$1 AND sealed<>''",
        [owner.workspaceId]
      )
    ).rows[0].n,
    0
  );
});
