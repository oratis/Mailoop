import { openapi, researchSchema } from '../packages/outreach/openapi.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { asMember, RequestError } from '../packages/db/database.ts';
import {
  approveDraft,
  createCampaign,
  getCampaign,
  listCampaigns,
  readEvents
} from '../packages/domain/campaigns.ts';
import { dispatchRoute, unsubscribe, type Settings } from '../packages/outreach/routes.ts';
import { oauthCallback } from '../packages/outreach/mailbox-auth.ts';
import { receiveEvent } from '../packages/outreach/ingress.ts';
import { streamJournal } from '../packages/outreach/stream.ts';
import { id } from '../packages/outreach/security.ts';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RequestError(413, 'Request body exceeds 1 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* Report invalid JSON and invalid shapes consistently. */
  }
  throw new RequestError(400, 'Expected a JSON object.');
}

const shell =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mailoop · Campaigns</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script src="/main.js" defer></script></body></html>';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createApi(pool: Pool, settings?: Settings) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (
        req.method === 'GET' &&
        ['/openapi.json', '/schemas/research-result.json'].includes(url.pathname)
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(url.pathname === '/openapi.json' ? openapi : researchSchema));
        return;
      }
      const webhook = /^\/webhooks\/mail\/([a-f0-9-]+)\/([a-f0-9-]+)$/.exec(url.pathname);
      if (settings && webhook && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const chunk of req) {
          n += chunk.length;
          if (n > 65536) throw new RequestError(413, 'Event too large.');
          chunks.push(chunk);
        }
        const result = await receiveEvent(
          pool,
          settings.vault,
          webhook[1],
          webhook[2],
          String(req.headers['x-mailoop-timestamp'] ?? ''),
          String(req.headers['x-mailoop-signature'] ?? ''),
          Buffer.concat(chunks)
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (settings && url.pathname.startsWith('/unsubscribe/')) {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<form method="post"><button name="List-Unsubscribe" value="One-Click">Unsubscribe</button></form>'
          );
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const part of req) {
            size += part.length;
            if (size > 256) throw new RequestError(413, 'Invalid unsubscribe request.');
            chunks.push(part);
          }
          if (
            new URLSearchParams(Buffer.concat(chunks).toString()).get('List-Unsubscribe') !== 'One-Click'
          )
            throw new RequestError(400, 'Invalid unsubscribe request.');
          await unsubscribe(pool, settings.vault, url.pathname.slice(13));
          res.writeHead(200);
          res.end('Unsubscribed');
          return;
        }
      }
      const callback = /^\/oauth\/(gmail|graph|feishu|nylas)\/callback$/.exec(url.pathname);
      if (settings && callback && req.method === 'GET') {
        await oauthCallback(
          pool,
          settings.vault,
          settings.base,
          callback[1],
          url.searchParams.get('state') ?? '',
          url.searchParams.get('code') ?? ''
        );
        res.writeHead(303, { Location: '/workspace' });
        res.end();
        return;
      }
      if (
        req.method === 'GET' &&
        ['/', '/workspace', '/main.js', '/main.css', '/workspace.js', '/workspace.css'].includes(
          url.pathname
        )
      ) {
        const workspace =
          url.pathname === '/workspace' || (url.pathname === '/' && settings?.defaultWorkspace);
        const file = workspace ? '' : url.pathname.slice(1);
        const body = file
          ? await readFile(new URL('../dist/console/' + file, import.meta.url))
          : workspace
            ? shell.replaceAll('/main.', '/workspace.')
            : shell;
        res.writeHead(200, {
          'Content-Type': file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html; charset=utf-8'
        });
        res.end(body);
        return;
      }
      const token = /^Bearer ([\w-]+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new RequestError(401, 'Open the workspace link printed by the demo.');
      const stream = /^\/v1\/outreach\/(campaigns|runs)\/([^/]+)\/stream$/.exec(url.pathname);
      if (settings && stream && req.method === 'GET') {
        await streamJournal(
          req,
          res,
          pool,
          settings,
          token,
          stream[1],
          id(stream[2]),
          String(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0')
        );
        return;
      }
      const body = ['POST', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : {};
      const result = await asMember(pool, token, async (client, member) => {
        if (settings && url.pathname.startsWith('/v1/outreach/'))
          return dispatchRoute({ db: client, member, ...settings }, url, req.method ?? 'GET', body);
        if (url.pathname === '/v1/me' && req.method === 'GET') return member;
        if (settings?.defaultWorkspace) throw new RequestError(404, 'Resource not found.');
        if (url.pathname === '/v1/campaigns') {
          if (req.method === 'GET') return listCampaigns(client);
          if (req.method === 'POST') return createCampaign(client, member, body.name);
        }
        const match = /^\/v1\/campaigns\/([^/]+)(?:\/(approve|events))?$/.exec(url.pathname);
        if (match && uuid.test(match[1])) {
          const [, id, action] = match;
          if (req.method === 'GET' && !action) return getCampaign(client, id);
          if (req.method === 'POST' && action === 'approve')
            return approveDraft(client, member, id, body.revision);
          if (req.method === 'GET' && action === 'events') {
            const value = url.searchParams.get('after') ?? '0';
            if (!/^\d{1,10}$/.test(value) || Number(value) > 2147483647)
              throw new RequestError(422, 'Invalid event cursor.');
            return readEvents(client, id, Number(value));
          }
        }
        throw new RequestError(404, 'Resource not found.');
      });
      res.writeHead(url.pathname === '/v1/campaigns' && req.method === 'POST' ? 201 : 200, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      const expected = error instanceof RequestError;
      if (!expected)
        console.error('Mailoop request failed', error instanceof Error ? error.name : 'unknown error');
      res.writeHead(expected ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: expected ? error.message : 'Internal request error.' }));
    }
  });
}
