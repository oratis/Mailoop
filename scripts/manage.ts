import pg from 'pg';
import { initializeDemoDatabase, seedWorkspace } from '../packages/db/database.ts';
const db = process.env.MAILOOP_MIGRATION_URL;
if (!db) throw new Error('Set MAILOOP_MIGRATION_URL for this operator command.');
const pool = new pg.Pool({ connectionString: db });
try {
  const command = process.argv[2];
  if (command === 'migrate') {
    await initializeDemoDatabase(pool);
    const password = process.env.MAILOOP_DB_PASSWORD;
    if (!password) throw new Error('Set MAILOOP_DB_PASSWORD for the runtime login.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('mailoop.service-role'))");
      const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname='mailoop_service'"))
        .rowCount;
      const sql = (
        await client.query(
          "SELECT format('%s ROLE mailoop_service LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS sql",
          [exists ? 'ALTER' : 'CREATE', password]
        )
      ).rows[0].sql;
      await client.query(sql);
      await client.query('GRANT mailoop_demo_runtime TO mailoop_service');
      await client.query('GRANT USAGE ON SCHEMA mailoop TO mailoop_service');
      await client.query('GRANT SELECT (id) ON mailoop.workspaces TO mailoop_service');
      await client.query('REVOKE ALL ON mailoop.members FROM mailoop_service');
      await client.query('REVOKE UPDATE(active) ON mailoop.members FROM mailoop_service');
      await client.query(
        'GRANT EXECUTE ON FUNCTION mailoop.authenticate_member(text) TO mailoop_service'
      );
      await client.query('COMMIT');
      console.log('Database ready.');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else if (command === 'workspace' && process.argv[3]) {
    const w = await seedWorkspace(pool, process.argv[3], 'admin');
    console.log('Open the private owner link once and store it securely.');
    console.log(
      (process.env.MAILOOP_PUBLIC_URL ?? 'http://127.0.0.1:8080') + '/workspace#token=' + w.token
    );
  } else throw new Error('Commands: migrate | workspace NAME');
} finally {
  await pool.end();
}
