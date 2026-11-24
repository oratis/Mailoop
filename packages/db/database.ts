import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export type Member = { id: string; workspaceId: string; workspaceName: string; name: string; role: 'reviewer' | 'viewer' };

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDemoDatabase(pool: Pool) {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await transaction(pool, async client => { await client.query(schema); });
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function seedWorkspace(pool: Pool, name: string, role: Member['role'] = 'reviewer') {
  const token = randomBytes(32).toString('base64url');
  const workspaceId = await transaction(pool, async client => {
    const { rows: [workspace] } = await client.query('INSERT INTO mailoop.workspaces (name) VALUES ($1) RETURNING id', [name]);
    await client.query(
      'INSERT INTO mailoop.members (workspace_id, name, role, token_hash) VALUES ($1,$2,$3,$4)',
      [workspace.id, name + ' operator', role, hashToken(token)]
    );
    return workspace.id as string;
  });
  return { workspaceId, token, name };
}

export async function useWorkspace(client: PoolClient, workspaceId: string) {
  await client.query('SET LOCAL ROLE mailoop_demo_runtime');
  await client.query('SET LOCAL search_path = mailoop, pg_catalog');
  await client.query("SELECT set_config('mailoop.workspace', $1, true)", [workspaceId]);
}

export function asMember<T>(pool: Pool, token: string, work: (client: PoolClient, member: Member) => Promise<T>) {
  return transaction(pool, async client => {
    const result = await client.query<Member>(`
      SELECT m.id, m.name, m.role, w.id AS "workspaceId", w.name AS "workspaceName"
      FROM mailoop.members m JOIN mailoop.workspaces w ON w.id = m.workspace_id
      WHERE m.token_hash = $1 AND m.active FOR SHARE OF m`, [hashToken(token)]);
    const member = result.rows[0];
    if (!member) throw new RequestError(401, 'A valid workspace token is required.');
    await useWorkspace(client, member.workspaceId);
    return work(client, member);
  });
}

export function asWorkspace<T>(pool: Pool, workspaceId: string, work: (client: PoolClient) => Promise<T>) {
  return transaction(pool, async client => {
    await useWorkspace(client, workspaceId);
    return work(client);
  });
}
