import { RequestError } from '../db/database.ts';
import { field, integer } from './security.ts';
import type { Input } from './context.ts';
import type { Artifact } from './imports.ts';

export function audienceCriteria(b: Input) {
  const language = b.language ? field(b.language, 'language', 35).toLowerCase() : null;
  const since = b.publishedAfter ? field(b.publishedAfter, 'publication cutoff', 10) : null;
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || new Date(since).toJSON()?.slice(0, 10) !== since))
    throw new RequestError(422, 'Invalid publication cutoff.');
  const maxCandidates = integer(b.maxCandidates ?? 100, 'candidate limit', 1, 100);
  return { language, since, maxCandidates };
}
export function filterAudience(a: Artifact, criteria?: ReturnType<typeof audienceCriteria>) {
  if (!criteria) return a;
  return {
    ...a,
    candidates: a.candidates
      .filter(
        (c) =>
          (!criteria.language ||
            c.language.toLowerCase() === criteria.language ||
            c.language.toLowerCase().startsWith(criteria.language + '-')) &&
          (!criteria.since || (!!c.work.publishedOn && c.work.publishedOn >= criteria.since))
      )
      .slice(0, criteria.maxCandidates)
  };
}
