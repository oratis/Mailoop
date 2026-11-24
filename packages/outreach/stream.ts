import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import type { Pool } from 'pg';
import { asMember, RequestError } from '../db/database.ts';
import { program } from './context.ts';
import type { Settings } from './routes.ts';

export async function streamJournal(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  settings: Settings,
  token: string,
  scope: string,
  resource: string,
  rawCursor: string
) {
  let last = Number(rawCursor);
  if (!Number.isSafeInteger(last) || last < 0) throw new RequestError(422, 'Invalid event cursor.');
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  async function page() {
    return asMember(pool, token, async (db, member) => {
      let campaign = resource;
      if (scope === 'runs') {
        const r = (
          await db.query('SELECT program_id FROM runs WHERE id=$1 AND owner_id=$2', [
            resource,
            member.id
          ])
        ).rows[0];
        if (!r) throw new RequestError(404, 'Run not found.');
        campaign = r.program_id;
      }
      await program({ db, member, ...settings }, campaign);
      return (
        await db.query(
          'SELECT seq,type,resource_id,detail,at FROM journal WHERE program_id=$1 AND seq>$2 AND ($3::uuid IS NULL OR resource_id=$3) ORDER BY seq LIMIT 100',
          [campaign, last, scope === 'runs' ? resource : null]
        )
      ).rows;
    });
  }
  let rows = await page();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  try {
    while (!abort.signal.aborted) {
      for (const row of rows) {
        if (!res.write('id: ' + row.seq + '\nevent: activity\ndata: ' + JSON.stringify(row) + '\n\n'))
          await once(res, 'drain', { signal: abort.signal });
        last = Number(row.seq);
      }
      if (rows.length < 100) {
        res.write(': heartbeat\n\n');
        await wait(1500, undefined, { signal: abort.signal });
      }
      rows = await page();
    }
  } catch {
    res.end();
  }
}
