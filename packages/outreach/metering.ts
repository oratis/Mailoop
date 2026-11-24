import { RequestError } from '../db/database.ts';
import type { PoolClient } from 'pg';
export type Rates = { currency: string; input: number; output: number };
export function rates(value: unknown): Rates | null {
  if (value === undefined || value === null) return null;
  const v = value as Rates;
  if (
    !/^[A-Z]{3}$/.test(v.currency) ||
    ![v.input, v.output].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  )
    throw new RequestError(422, 'Provide currency and input/output prices per million tokens.');
  return { currency: v.currency, input: v.input, output: v.output };
}
export async function recordUsage(
  db: PoolClient,
  ws: string,
  invocation: string,
  usage: Record<string, number> | null,
  price: Rates | null
) {
  if (!usage) return;
  const input = usage.input_tokens ?? usage.promptTokenCount,
    output =
      usage.output_tokens ??
      (usage.candidatesTokenCount === undefined
        ? undefined
        : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0));
  // A two-price rate card cannot price cache read/write tiers or other modalities.
  const special =
    usage.cache_read_input_tokens ||
    usage.cache_creation_input_tokens ||
    usage.cachedContentTokenCount ||
    (usage as unknown as { input_tokens_details?: { cached_tokens?: number } }).input_tokens_details
      ?.cached_tokens;
  const amount =
    price && Number.isFinite(input) && Number.isFinite(output) && !special
      ? (input * price.input + output * price.output) / 1000000
      : null;
  await db.query(
    'UPDATE usage_facts SET units=$3,amount=$4,currency=$5 WHERE workspace_id=$1 AND id=$2',
    [ws, invocation, usage, amount, amount !== null ? price!.currency : null]
  );
}
