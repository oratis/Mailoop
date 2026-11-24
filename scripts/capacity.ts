import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { startLocalPostgres } from './local-postgres.ts';
import { asMember, seedWorkspace } from '../packages/db/database.ts';
import { type Context, newProgram } from '../packages/outreach/context.ts';
import { preview, applyImport } from '../packages/outreach/imports.ts';
import { directMailbox, grantMailbox } from '../packages/outreach/mailbox-auth.ts';
import { bridgeSecret, receiveEvent } from '../packages/outreach/ingress.ts';
import { messageId } from '../packages/outreach/mail-transports.ts';
import { report } from '../packages/outreach/reports.ts';
import { Vault } from '../packages/outreach/security.ts';

const env = await startLocalPostgres(),
  vault = new Vault(randomBytes(32)),
  ws = await seedWorkspace(env.pool, 'Capacity fixture', 'admin');
const context = <T>(work: (ctx: Context) => Promise<T>) =>
  asMember(env.pool, ws.token, (db, member) => work({ db, member, vault, base: 'http://localhost' }));
const synthetic = (n: number) => ({
  displayName: 'Studio ' + n,
  language: 'en',
  channelUrl: 'https://studio.example/' + n,
  matchReason: 'Coffee',
  work: { url: 'https://studio.example/work/' + n, publishedOn: '2026-10-01' },
  contacts: [
    {
      source: 'public_business_page',
      address: 'studio' + n + '@artist.example',
      evidenceUrl: 'https://studio.example/contact/' + n,
      evidenceExcerpt: 'Partnerships: studio' + n + '@artist.example',
      observedAt: new Date().toISOString()
    }
  ]
});
const dispatches: { id: string; sender: string; recipient: string; box: string; secret: string }[] = [];
const campaigns: string[] = [];
try {
  for (let group = 0; group < 5; group++) {
    await context(async (ctx) => {
      const p = await newProgram(ctx, {
        name: 'Study ' + group,
        brief: 'Find coffee creators',
        region: 'JP',
        purpose: 'Benchmark'
      });
      campaigns.push(p.id);
      for (let batch = 0; batch < 2; batch++) {
        const candidates = Array.from({ length: 100 }, (_, i) =>
          synthetic(200 * group + batch * 100 + i)
        );
        const a = await preview(ctx, p.id, {
          schemaVersion: 1,
          runId: 'run-' + group + '-' + batch,
          briefRevision: '1',
          researchedAt: new Date().toISOString(),
          candidates
        });
        await applyImport(ctx, p.id, a);
      }
      for (let n = 0; n < 4; n++) {
        const sender = 'sender' + group + n + '@brand.example',
          box = await directMailbox(ctx, { provider: 'simulated', address: sender });
        await grantMailbox(ctx, box.id, {
          campaignId: p.id,
          expiresAt: new Date(Date.now() + 86400000).toISOString()
        });
        const contacts = (
          await ctx.db.query(
            'SELECT id,sealed FROM prospects WHERE program_id=$1 ORDER BY id LIMIT 10 OFFSET $2',
            [p.id, n * 10]
          )
        ).rows;
        for (const c of contacts) {
          const recipient = vault.open<{ contacts: { address: string }[] }>(ws.workspaceId, c.sealed)
            .contacts[0].address;
          const id = randomUUID(),
            body = { from: sender, to: recipient, subject: 'Benchmark', body: 'Synthetic conversation' };
          await ctx.db.query(
            "INSERT INTO letters(workspace_id,id,prospect_id,mailbox_id,step,status,sealed,attempted_at,accepted_at,receipt) VALUES($1,$2,$3,$4,'first','accepted',$5,now(),now(),$6)",
            [ws.workspaceId, id, c.id, box.id, vault.seal(ws.workspaceId, body), 'sim-' + id]
          );
          dispatches.push({
            id,
            sender,
            recipient,
            box: box.id,
            secret: bridgeSecret(vault, ws.workspaceId, box.id, 2)
          });
        }
      }
    });
  }
  let cursor = 0,
    duplicates = 0,
    failures = 0;
  const latencies: number[] = [],
    first = performance.now(),
    unique = 10000,
    requests = unique * 3;
  async function consume() {
    while (cursor < requests) {
      const i = cursor++,
        n = i % unique,
        l = dispatches[n % dispatches.length],
        at = String(Math.floor(Date.now() / 1000));
      const raw = Buffer.from(
        JSON.stringify({
          eventId: 'event-' + n,
          kind: 'reply',
          address: l.recipient,
          at: new Date().toISOString(),
          references: [messageId(l.id, l.sender)],
          text: 'Synthetic reply'
        })
      );
      const signature = createHmac('sha256', l.secret)
        .update(at + '.')
        .update(raw)
        .digest('hex');
      const start = performance.now();
      try {
        const r = await receiveEvent(env.pool, vault, ws.workspaceId, l.box, at, signature, raw);
        if ('duplicate' in r && r.duplicate) duplicates++;
      } catch {
        failures++;
      }
      latencies.push(performance.now() - start);
    }
  }
  await Promise.all(Array.from({ length: 8 }, consume));
  const seconds = (performance.now() - first) / 1000;
  assert.equal(failures, 0);
  assert.equal(duplicates, 2 * unique);
  const count = await env.pool.query(
    'SELECT count(*)::int AS n FROM mailoop.inbound WHERE workspace_id=$1',
    [ws.workspaceId]
  );
  assert.equal(count.rows[0].n, unique);
  const reportStart = performance.now();
  for (const c of campaigns) {
    const r = await context((ctx) => report(ctx, c, null, null));
    assert.equal(r.reply.numerator, 40);
  }
  const sorted = latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        campaigns: 5,
        mailboxes: 20,
        candidates: 1000,
        acceptedHistory: 200,
        notifications: requests,
        unique,
        duplicates,
        failures,
        seconds: +seconds.toFixed(2),
        requestsPerSecond: Math.round(requests / seconds),
        notificationP95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
        fiveReportsMs: Math.round(performance.now() - reportStart),
        databaseBytes: Number(
          (await env.pool.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes
        )
      },
      null,
      2
    )
  );
} finally {
  await env.close();
}
