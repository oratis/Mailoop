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
const pool = new pg.Pool({ connectionString: url, max: 12 }),
  settings = {
    vault: new Vault(Buffer.from(key, 'base64')),
    base: origin.origin,
    allowReal: process.env.MAILOOP_SEND_ENABLED === 'true',
    defaultWorkspace: true
  };
let stopping = false;
const stop = () => {
  stopping = true;
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  const {
    rows: [role]
  } = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if (role.rolsuper || role.rolbypassrls) throw new Error('Use the dedicated runtime database login.');
  if (process.argv[2] === 'worker') {
    while (!stopping) {
      const workspaces = (await pool.query('SELECT id FROM mailoop.workspaces ORDER BY id')).rows;
      for (const { id } of workspaces) {
        try {
          await deliveryTick(pool, id, settings.vault, settings.base, settings.allowReal);
          await researchTick(pool, id, settings.vault, settings.base);
        } catch (e) {
          console.error('Workspace task failed', e instanceof Error ? e.name : 'Error');
        }
        if (stopping) break;
      }
      if (!stopping) await delay(900);
    }
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
