import { rates } from './metering.ts';
import { RequestError } from '../db/database.ts';
import { type Context, type Input, requireRole } from './context.ts';
import { field } from './security.ts';
export const modelProviders = ['openai', 'anthropic', 'gemini', 'local-artifact'] as const;
export async function bindModel(ctx: Context, b: Input) {
  requireRole(ctx, 'operator', 'reviewer', 'researcher');
  const provider = field(b.provider, 'provider'),
    model = field(b.model, 'model', 120);
  if (!modelProviders.some((p) => p === provider) || !/^[\w.:-]+$/.test(model))
    throw new RequestError(422, 'Unsupported provider or model.');
  const key = provider === 'local-artifact' ? '' : field(b.key, 'API key', 4000);
  const {
    rows: [binding]
  } = await ctx.db.query(
    'INSERT INTO bindings(workspace_id,owner_id,provider,model,secret,rates) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,provider,model,active',
    [
      ctx.member.workspaceId,
      ctx.member.id,
      provider,
      model,
      ctx.vault.seal(ctx.member.workspaceId, key),
      rates(b.rates)
    ]
  );
  return binding;
}
export async function generate(
  provider: string,
  model: string,
  key: string,
  instructions: string,
  input: string,
  transport: typeof fetch = fetch
) {
  let url: string,
    body: object,
    headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/responses';
    headers.Authorization = 'Bearer ' + key;
    body = { model, instructions, input, store: false, max_output_tokens: 6000 };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      system: instructions,
      max_tokens: 6000,
      messages: [{ role: 'user', content: input }]
    };
  } else if (provider === 'gemini') {
    url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent';
    headers['x-goog-api-key'] = key;
    body = {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 6000 }
    };
  } else throw new RequestError(422, 'This binding runs on the member device.');
  const r = await transport(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok)
    throw new RequestError(
      [401, 403].includes(r.status) ? 401 : 503,
      'Model provider returned ' + r.status
    );
  const d = await r.json();
  const text =
    provider === 'openai'
      ? (d.output ?? [])
          .flatMap((x: { content?: { text: string }[] }) => x.content ?? [])
          .map((x: { text: string }) => x.text)
          .join('')
      : provider === 'anthropic'
        ? (d.content ?? []).map((x: { text: string }) => x.text).join('')
        : (d.candidates?.[0]?.content?.parts ?? []).map((x: { text: string }) => x.text).join('');
  try {
    return {
      value: JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')),
      usage: d.usage ?? d.usageMetadata ?? null
    };
  } catch {
    throw new RequestError(422, 'Model output was not valid JSON.');
  }
}
