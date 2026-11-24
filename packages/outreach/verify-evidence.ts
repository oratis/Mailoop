import type { Artifact } from './imports.ts';
import type { Source } from './sources.ts';

// The citation comes from the page actually fetched, even if the model proposed
// a profile URL or paraphrased the source. Ambiguous evidence stays in review.
export function verifyEvidence(a: Artifact, sources: Source[]): Artifact {
  return {
    ...a,
    candidates: a.candidates.map((c) => {
      const contacts = c.contacts.flatMap((contact) => {
        if (contact.source !== 'public_business_page') return [];
        const matching = sources.flatMap((s) => {
          const index = s.text.indexOf(contact.address);
          if (index < 0) return [];
          const exact = contact.evidenceExcerpt ?? '';
          if (exact.includes(contact.address) && s.text.includes(exact))
            return [{ source: s, excerpt: exact }];
          const excerpt = s.text.slice(Math.max(0, index - 130), index + contact.address.length + 110);
          if (
            !/partnership|business inquir|collaborat|合作|商务|コラボ|お問い合わせ|提携|협업|geschäftlich/i.test(
              excerpt
            )
          )
            return [];
          return [{ source: s, excerpt }];
        });
        const cited =
          matching.find((m) => m.source.url === contact.evidenceUrl) ??
          (matching.length === 1 ? matching[0] : undefined);
        return cited
          ? [{ ...contact, evidenceUrl: cited.source.url, evidenceExcerpt: cited.excerpt }]
          : [];
      });
      return contacts.length
        ? { ...c, contacts }
        : {
            ...c,
            contacts: [],
            missingReason: c.missingReason ?? 'no_verified_public_business_contact'
          };
    })
  };
}
