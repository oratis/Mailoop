import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { RequestError } from '../db/database.ts';

export function publicAddress(address: string) {
  return ipaddr.process(address).range() === 'unicast';
}
export type Source = { url: string; text: string };
export async function readPublicSource(raw: string, hops = 0): Promise<Source> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || hops > 3)
    throw new RequestError(422, 'Source must be a public HTTPS page.');
  const host = u.hostname.replace(/^\[|\]$/g, ''),
    records = await lookup(host, { all: true });
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new RequestError(422, 'Source is not publicly routable.');
  const pinned = records[0];
  const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request(
      u,
      {
        agent: false,
        signal: AbortSignal.timeout(8000),
        family: pinned.family,
        lookup: (_host, _opts, cb) => cb(null, pinned.address, pinned.family),
        headers: { Accept: 'text/html,text/plain', 'User-Agent': 'Mailoop/0.1' }
      },
      resolve
    );
    req.on('error', reject);
    req.end();
  });
  if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    res.destroy();
    return readPublicSource(new URL(res.headers.location, u).href, hops + 1);
  }
  if (res.statusCode !== 200 || !/^text\/(plain|html)\b/i.test(res.headers['content-type'] ?? '')) {
    res.destroy();
    throw new RequestError(422, 'Unsupported source response.');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 512000) {
      res.destroy();
      throw new RequestError(422, 'Source exceeds 512 KB.');
    }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { url: u.href, text: text.slice(0, 16000) };
}
export async function searchBrave(query: string, key: string, count: number) {
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', query.slice(0, 400));
  u.searchParams.set('count', String(count));
  const r = await fetch(u, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok)
    throw new RequestError(r.status === 401 ? 401 : 503, 'Search provider returned ' + r.status);
  const data = await r.json();
  return (data.web?.results ?? []).map((x: { url: string }) => x.url).slice(0, count) as string[];
}

export async function searchPublicSources(brief: string, count: number): Promise<string[]> {
  if (process.env.BRAVE_SEARCH_API_KEY)
    return searchBrave(brief, process.env.BRAVE_SEARCH_API_KEY, count);
  const key = process.env.MAILOOP_SEARCH_OPENAI_KEY;
  if (!key) throw new RequestError(401, 'Configure a search service or supply public URLs.');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: process.env.MAILOOP_SEARCH_MODEL ?? 'gpt-4.1-mini',
      store: false,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      max_tool_calls: 1,
      max_output_tokens: 1000,
      include: ['web_search_call.action.sources'],
      instructions: 'Find public pages matching the audience brief. Search once. Return source links.',
      input: brief
    })
  });
  if (!response.ok)
    throw new RequestError(
      [401, 403].includes(response.status) ? 401 : 503,
      'Search provider returned ' + response.status
    );
  const { output } = await response.json();
  const urls = new Set<string>();
  for (const item of output ?? []) {
    if (item.type === 'web_search_call')
      for (const source of item.action?.sources ?? [])
        if (typeof source.url === 'string') urls.add(source.url);
    if (item.type === 'message')
      for (const part of item.content ?? [])
        for (const citation of part.annotations ?? [])
          if (citation.type === 'url_citation' && typeof citation.url === 'string')
            urls.add(citation.url);
  }
  return [...urls].slice(0, count);
}
