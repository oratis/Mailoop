import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { asMember, RequestError } from '../packages/db/database.ts';
import { approveDraft, createCampaign, getCampaign, listCampaigns, readEvents } from '../packages/domain/campaigns.ts';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new RequestError(413, 'Request body exceeds 8 KiB.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* Report invalid JSON and invalid shapes consistently. */ }
  throw new RequestError(400, 'Expected a JSON object.');
}

const shell = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mailoop · Campaigns</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script src="/main.js" defer></script></body></html>';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createApi(pool: Pool) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && ['/', '/main.js', '/main.css'].includes(url.pathname)) {
        const file = url.pathname.slice(1);
        const body = file ? await readFile(new URL('../dist/console/' + file, import.meta.url)) : shell;
        res.writeHead(200, { 'Content-Type': file === 'main.js' ? 'text/javascript' : file === 'main.css' ? 'text/css' : 'text/html; charset=utf-8' });
        res.end(body);
        return;
      }
      const token = /^Bearer ([\w-]+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new RequestError(401, 'Open the workspace link printed by the demo.');
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await asMember(pool, token, async (client, member) => {
        if (url.pathname === '/v1/me' && req.method === 'GET') return member;
        if (url.pathname === '/v1/campaigns') {
          if (req.method === 'GET') return listCampaigns(client);
          if (req.method === 'POST') return createCampaign(client, member, body.name);
        }
        const match = /^\/v1\/campaigns\/([^/]+)(?:\/(approve|events))?$/.exec(url.pathname);
        if (match && uuid.test(match[1])) {
          const [, id, action] = match;
          if (req.method === 'GET' && !action) return getCampaign(client, id);
          if (req.method === 'POST' && action === 'approve') return approveDraft(client, member, id, body.revision);
          if (req.method === 'GET' && action === 'events') {
            const value = url.searchParams.get('after') ?? '0';
            if (!/^\d{1,10}$/.test(value) || Number(value) > 2147483647) throw new RequestError(422, 'Invalid event cursor.');
            return readEvents(client, id, Number(value));
          }
        }
        throw new RequestError(404, 'Resource not found.');
      });
      res.writeHead(url.pathname === '/v1/campaigns' && req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const expected = error instanceof RequestError;
      if (!expected) console.error('Mailoop request failed', error instanceof Error ? error.name : 'unknown error');
      res.writeHead(expected ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: expected ? error.message : 'Internal request error.' }));
    }
  });
}
