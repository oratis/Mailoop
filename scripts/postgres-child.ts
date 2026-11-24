import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';

const directory = process.argv[2];
if (!directory || !process.send) throw new Error('Use the local PostgreSQL launcher.');
const disconnected = once(process, 'disconnect');
const config = await Promise.race([once(process, 'message').then(([message]) => message), disconnected.then(() => null)]);
if (config) {
  const database = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', port: config.port, password: config.password,
    persistent: false, autoRehydrateSymlinks: true, authMethod: 'scram-sha-256',
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='],
    onLog: () => {}, onError: () => {}
  });
  try {
    await database.initialise();
    await database.start();
    if (process.connected) process.send('ready');
    await disconnected;
  } finally {
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
