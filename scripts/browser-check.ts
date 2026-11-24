import { expect, chromium } from '@playwright/test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createApi } from '../apps/api.ts';
import { startLocalPostgres } from './local-postgres.ts';
import { seedWorkspace } from '../packages/db/database.ts';
import { deliveryTick } from '../packages/outreach/delivery.ts';
import { Vault } from '../packages/outreach/security.ts';

const env = await startLocalPostgres(),
  vault = new Vault(randomBytes(32)),
  settings = { vault, base: '', allowReal: false, defaultWorkspace: true };
const server = createApi(env.pool, settings).listen(0, '127.0.0.1');
await once(server, 'listening');
const base = (settings.base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port);
let browser;
try {
  browser = await chromium.launch({ channel: process.env.MAILOOP_BROWSER_CHANNEL });
  const page = await browser.newPage();
  const workspace = await seedWorkspace(env.pool, 'Browser acceptance', 'admin'),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/workspace#token=' + workspace.token);
  await page.getByLabel('Name', { exact: true }).fill('Coffee QA');
  await page.getByLabel('Audience brief').fill('Japanese home coffee creators');
  await page.getByLabel('Contact purpose').fill('Test partnership');
  await page.getByLabel('Recipient market').fill('JP');
  await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Coffee QA' })).toBeVisible();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByText('SMTP or simulator', { exact: true }).click();
  await page.getByLabel('Mailbox address', { exact: true }).fill('member@brand.example');
  await page.getByRole('button', { name: 'Verify and connect' }).click();
  await page.getByText('member@brand.example · Connected', { exact: true }).click();
  await page.getByRole('button', { name: 'Delegate to this campaign' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  const sample = JSON.parse(
    await readFile(new URL('../docs/examples/research-result.json', import.meta.url), 'utf8')
  );
  sample.briefRevision = '1';
  await page
    .getByLabel('Research JSON')
    .setInputFiles({
      name: 'sample.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(sample))
    });
  await page.getByRole('button', { name: 'Preview artifact' }).click();
  await expect(page.getByText('missing_evidence', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply reviewed import' }).click();
  await expect(page.getByRole('button', { name: 'Apply reviewed import' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Creators', exact: true }).click();
  await page.getByText('Demo Coffee Studio · shortlisted', { exact: true }).click();
  await page.getByLabel('Consent evidence for Test partnership in JP').fill('Synthetic test opt-in');
  await page.getByRole('button', { name: 'Record verified consent' }).click();
  await page.getByLabel('Subject for manual draft').first().fill('Coffee partnership');
  await page.getByLabel('Body for manual draft').first().fill('A synthetic partnership proposal.');
  await page.getByRole('button', { name: 'Create first draft' }).first().click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Outbox', exact: true }).click();
  await page.getByText('Coffee partnership · draft', { exact: true }).click();
  await page.getByLabel('Approve this revision').check();
  await page.getByRole('button', { name: 'Approve 1 selected' }).click();
  await expect(page.getByText('Coffee partnership · scheduled', { exact: true })).toBeVisible();
  await deliveryTick(env.pool, workspace.workspaceId, vault, base, false);
  const {
    rows: [letter]
  } = await env.pool.query('SELECT id FROM mailoop.letters WHERE workspace_id=$1', [
    workspace.workspaceId
  ]);
  const receipt = await fetch(base + '/v1/outreach/letters/' + letter.id + '/simulate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + workspace.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'interested',
      sourceId: 'browser-reply',
      text: 'Interested in this test collaboration.'
    })
  });
  expect(receipt.status).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page.getByText('Demo Coffee Studio · Interested', { exact: true })).toBeVisible();
  await page.getByText('Demo Coffee Studio · Interested', { exact: true }).click();
  await expect(page.getByText('Interested in this test collaboration.', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export aggregate JSON' }).click();
  expect((await download).suggestedFilename()).toBe('mailoop-report.json');
  expect(errors).toEqual([]);
  console.log('Browser campaign, evidence, approval, reply drill-down and aggregate export passed.');
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await env.close();
}
