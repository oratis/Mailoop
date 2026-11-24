import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApi } from '../apps/api.ts';
import { processOne } from '../apps/worker.ts';
import { MailoopClient } from '../packages/client.ts';
import { SimulatedMailbox } from '../packages/connectors/simulated-mailbox.ts';
import { seedWorkspace } from '../packages/db/database.ts';
import { startLocalPostgres } from '../scripts/local-postgres.ts';

let database: Awaited<ReturnType<typeof startLocalPostgres>>;
let server: ReturnType<typeof createApi>;
let base: string;
before(async () => {
  database = await startLocalPostgres();
  server = createApi(database.pool).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (database) await database.close();
});

async function workspace(name: string) {
  const identity = await seedWorkspace(database.pool, name);
  return { ...identity, api: new MailoopClient(base, identity.token) };
}
async function raw(token: string, path: string, method = 'GET', body?: object) {
  return fetch(base + '/v1' + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
  });
}

test('tenant boundaries apply to lists, detail, approvals and events; revocation is immediate', async () => {
  const a = await workspace('Alpha');
  const b = await workspace('Beta');
  const first = await a.api.create('November');
  const second = await b.api.create('November');
  assert.deepEqual((await a.api.campaigns()).map(c => c.id), [first.id]);
  assert.deepEqual((await b.api.campaigns()).map(c => c.id), [second.id]);
  for (const path of ['', '/events']) assert.equal((await raw(b.token, '/campaigns/' + first.id + path)).status, 404);
  assert.equal((await raw(b.token, '/campaigns/' + first.id + '/approve', 'POST', { revision: first.revision })).status, 404);
  assert.equal((await raw('invalid', '/me')).status, 401);
  await database.pool.query('UPDATE mailoop.members SET active=false WHERE workspace_id=$1', [a.workspaceId]);
  assert.equal((await raw(a.token, '/campaigns')).status, 401);
});

test('viewer can inspect a draft but only reviewers can approve its exact revision', async () => {
  const a = await workspace('Permissions');
  assert.equal((await raw(a.token, '/campaigns', 'POST', { name: '   ' })).status, 422);
  const campaign = await a.api.create('Reviewer check');
  assert.match(campaign.draft.source, /\.example\//);
  assert.notEqual(campaign.draft.permission.grantedBy, campaign.draft.evidence);
  const path = '/campaigns/' + campaign.id;
  assert.equal((await raw(a.token, path + '/approve', 'POST', { revision: 'outdated' })).status, 409);
  assert.equal((await raw(a.token, path + '/events?after=-1')).status, 422);
  await database.pool.query("UPDATE mailoop.members SET role='viewer' WHERE workspace_id=$1", [a.workspaceId]);
  assert.equal((await raw(a.token, path)).status, 200);
  assert.equal((await raw(a.token, path + '/approve', 'POST', { revision: campaign.revision })).status, 403);
  assert.equal((await raw(a.token, '/campaigns', 'POST', { name: 'New' })).status, 403);
  assert.equal((await a.api.campaign(campaign.id)).stage, 'draft');
});

test('concurrent approval, worker races and a lost receipt converge on one submission and one reply', async () => {
  const a = await workspace('Reconciliation');
  const campaign = await a.api.create('Reconcile');
  await Promise.all(Array.from({ length: 8 }, () => a.api.approve(campaign.id, campaign.revision)));
  const lossy = new SimulatedMailbox(database.pool, true);
  await processOne(database.pool, lossy, a.workspaceId);
  assert.equal((await a.api.campaign(campaign.id)).stage, 'unknown');
  const checkpoint = (await a.api.events(campaign.id)).at(-1)!.sequence;
  const resumed = new SimulatedMailbox(database.pool);
  for (let i = 0; i < 3; i++) {
    await Promise.all(Array.from({ length: 4 }, () => processOne(database.pool, resumed, a.workspaceId)));
  }
  const final = await a.api.campaign(campaign.id);
  assert.equal(final.stage, 'replied');
  assert.ok(final.reply && final.receiptId);
  assert.equal((await processOne(database.pool, resumed, a.workspaceId)), false);
  const events = await a.api.events(campaign.id);
  assert.deepEqual(events.map(e => e.type), [
    'draft.created', 'approval.granted', 'dispatch.submitting', 'dispatch.unknown', 'dispatch.accepted', 'inbound.matched'
  ]);
  assert.deepEqual(await a.api.events(campaign.id, checkpoint), events.filter(e => e.sequence > checkpoint));
  const providerRows = await database.pool.query('SELECT * FROM mailoop.simulated_receipts WHERE workspace_id=$1', [a.workspaceId]);
  assert.equal(providerRows.rowCount, 1);
  assert.equal(providerRows.rows[0].receipt_id, final.receiptId);
});

test('expired handoff with no provider evidence stays unknown across recovery', async () => {
  const a = await workspace('Interrupted');
  const campaign = await a.api.create('Unconfirmed');
  await a.api.approve(campaign.id, campaign.revision);
  await database.pool.query("UPDATE mailoop.dispatches SET state='submitting', due_at=now()-interval '1 minute' WHERE workspace_id=$1", [a.workspaceId]);
  await processOne(database.pool, new SimulatedMailbox(database.pool), a.workspaceId);
  assert.equal((await a.api.campaign(campaign.id)).stage, 'unknown');
  assert.equal((await database.pool.query('SELECT * FROM mailoop.simulated_receipts WHERE workspace_id=$1', [a.workspaceId])).rowCount, 0);
});

test('CLI drives the same API through create, review, approval, delivery and incremental replay', async () => {
  const a = await workspace('CLI');
  const cli = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'apps/cli.ts', ...args],
      { env: { ...process.env, MAILOOP_URL: base, MAILOOP_TOKEN: a.token } });
    return JSON.parse(result.stdout);
  };
  const created = await cli('create', 'CLI sample');
  assert.equal((await cli('list'))[0].id, created.id);
  assert.equal((await cli('show', created.id)).draft.to, 'partnerships@coffee-studio.example');
  assert.equal((await cli('approve', created.id, created.revision)).stage, 'scheduled');
  const mailbox = new SimulatedMailbox(database.pool);
  await processOne(database.pool, mailbox, a.workspaceId);
  await processOne(database.pool, mailbox, a.workspaceId);
  assert.deepEqual((await cli('events', created.id, '3')).map((e: { type: string }) => e.type), ['dispatch.accepted', 'inbound.matched']);
});
