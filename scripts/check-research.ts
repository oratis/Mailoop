import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { startLocalPostgres } from './local-postgres.ts';
import { asMember, seedWorkspace } from '../packages/db/database.ts';
import { Vault } from '../packages/outreach/security.ts';
import { newProgram } from '../packages/outreach/context.ts';
import { type Artifact } from '../packages/outreach/imports.ts';
import { bindModel } from '../packages/outreach/models.ts';
import { researchTick, startRun } from '../packages/outreach/runs.ts';

const [provider, model, url] = process.argv.slice(2),
  key = process.env.MAILOOP_TEST_MODEL_KEY;
if (!key || !['openai', 'anthropic', 'gemini'].includes(provider) || !model || !url)
  throw Error(
    'Set MAILOOP_TEST_MODEL_KEY and pass PROVIDER MODEL and the public URL of docs/examples/research-result.json.'
  );
const env = await startLocalPostgres(),
  vault = new Vault(randomBytes(32));
try {
  const owner = await seedWorkspace(env.pool, 'Integration test', 'admin'),
    base = 'http://localhost';
  const run = await asMember(env.pool, owner.token, async (db, member) => {
    const ctx = { db, member, vault, base };
    const p = await newProgram(ctx, {
      name: 'Coffee research',
      brief:
        'Extract both synthetic creators from the supplied Japanese coffee directory. Preserve the evidence quote and explicitly published partnership email for the first. Record the missing contact reason for the second.',
      purpose: 'Research evaluation',
      region: 'JP'
    });
    const b = await bindModel(ctx, { provider, model, key });
    return startRun(ctx, p.id, { bindingId: b.id, urls: [url], budget: 1, requestKey: 'source-test' });
  });
  for (let i = 0; i < 2; i++) await researchTick(env.pool, owner.workspaceId, vault, base);
  const {
    rows: [r]
  } = await env.pool.query(
    'SELECT r.status,r.calls,r.note,i.sealed FROM mailoop.runs r LEFT JOIN mailoop.imports i ON i.id::text=r.note WHERE r.id=$1',
    [run.id]
  );
  assert.equal(r.status, 'completed', r.note);
  assert.equal(r.calls, 1);
  const rows = vault.open<Artifact>(owner.workspaceId, r.sealed).candidates;
  assert.equal(rows.length, 2);
  assert.ok(
    rows.some((c) =>
      c.contacts.some(
        (v) =>
          v.address === 'partnerships@coffee-studio.example' &&
          v.evidenceUrl === url &&
          v.evidenceExcerpt?.includes(v.address)
      )
    )
  );
  assert.ok(rows.some((c) => !c.contacts.length && c.missingReason));
  console.log(provider + ' passed with 2 candidates, 1 cited contact and 1 missing contact.');
} finally {
  await env.close();
}
