import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { initializeDemoDatabase } from '../packages/db/database.ts';

export async function startLocalPostgres() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  const directory = await mkdtemp(join(tmpdir(), 'mailoop-'));
  const password = randomBytes(32).toString('hex');
  // The embedded server installs process-wide signal handlers. Isolate it so
  // the HTTP server and pool can drain before PostgreSQL shuts down.
  const child = fork(new URL('./postgres-child.ts', import.meta.url), [directory], {
    execArgv: ['--import', 'tsx'], detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  const exited = once(child, 'exit');
  const pool = new pg.Pool({ user: 'postgres', password, database: 'postgres', host: '127.0.0.1', port });
  async function close() {
    await pool.end();
    if (child.connected) child.disconnect();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const ready = once(child, 'message');
    child.send({ port, password });
    await Promise.race([ready, exited.then(() => { throw new Error('Demo PostgreSQL exited during startup.'); })]);
    await initializeDemoDatabase(pool);
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
