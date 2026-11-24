import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
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
  const database = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'), user: 'postgres', password, port,
    persistent: true, autoRehydrateSymlinks: true, authMethod: 'scram-sha-256',
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='],
    onLog: () => {}, onError: () => {}
  });
  const pool = new pg.Pool({ user: 'postgres', password, database: 'postgres', host: '127.0.0.1', port });
  async function close() {
    await pool.end();
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await database.initialise();
    await database.start();
    await initializeDemoDatabase(pool);
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
