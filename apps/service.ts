import { syncTick } from '../packages/outreach/mailbox-sync.ts';
import { cleanup } from '../packages/outreach/retention.ts';
import { loadExtensions } from '../packages/connectors/sdk.ts';
import pg from 'pg';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from './api.ts';
import { deliveryTick } from '../packages/outreach/delivery.ts';
import { researchTick } from '../packages/outreach/runs.ts';
import { Vault } from '../packages/outreach/security.ts';

const url = process.env.DATABASE_URL,
  key = process.env.MAILOOP_MASTER_KEY,
  publicUrl = process.env.MAILOOP_PUBLIC_URL;
if (!url || !key || !publicUrl)
  throw new Error('Set DATABASE_URL, MAILOOP_MASTER_KEY and MAILOOP_PUBLIC_URL.');
await loadExtensions();
const origin = new URL(publicUrl);
if (
  origin.origin !== publicUrl ||
  (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.protocol !== 'https:')
)
  throw new Error('Set a public HTTPS origin or a loopback origin.');
if (process.env.MAILOOP_SEND_ENABLED === 'true' && origin.protocol !== 'https:')
  throw new Error('Real delivery requires a public HTTPS unsubscribe origin.');
const orgCap = Number(process.env.MAILOOP_ORG_DAILY_CAP ?? 500);
if (!Number.isSafeInteger(orgCap) || orgCap < 1)
  throw new Error('Set a positive organization daily cap.');
const pool = new pg.Pool({ connectionString: url, max: 12 }),
  settings = {
    vault: new Vault(Buffer.from(key, 'base64')),
    base: origin.origin,
    allowReal: process.env.MAILOOP_SEND_ENABLED === 'true',
    defaultWorkspace: true
  };
const shutdown = new AbortController();
let stopping = false;
const stop = () => {
  stopping = true;
  shutdown.abort();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  const {
    rows: [role]
  } = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if (role.rolsuper || role.rolbypassrls) throw new Error('Use the dedicated runtime database login.');
  if (process.argv[2] === 'worker') {
    async function loop(task: (ws: string) => Promise<unknown>, interval: number) {
      while (!stopping) {
        try {
          const { rows } = await pool.query('SELECT id FROM mailoop.workspaces ORDER BY id');
          for (let offset = 0; offset < rows.length && !stopping; offset += 4) {
            const results = await Promise.allSettled(
              rows.slice(offset, offset + 4).map(({ id }) => task(id))
            );
            for (const result of results)
              if (result.status === 'rejected')
                console.error(
                  'Workspace task failed',
                  result.reason instanceof Error ? result.reason.name : 'Error'
                );
          }
        } catch (error) {
          console.error('Worker polling failed', error instanceof Error ? error.name : 'Error');
        }
        if (!stopping) await delay(interval, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    }
    await Promise.all([
      loop((ws) => deliveryTick(pool, ws, settings.vault, settings.base, settings.allowReal), 900),
      loop((ws) => syncTick(pool, ws, settings.vault), 1500),
      loop((ws) => researchTick(pool, ws, settings.vault, settings.base), 900),
      loop((ws) => cleanup(pool, ws, settings.vault), 3600000)
    ]);
  } else {
    const server = createApi(pool, settings);
    const done = new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1');
    await once(server, 'listening');
    console.log('Mailoop listening', settings.base);
    await done;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
} finally {
  await pool.end();
}
