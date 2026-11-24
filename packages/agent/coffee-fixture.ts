import { readFileSync } from 'node:fs';

type Contact = { source: string; address: string; evidenceUrl: string; evidenceExcerpt: string };
type Candidate = {
  displayName: string; language: string; work: { url: string; publishedOn: string | null };
  contacts: Contact[];
};
type Fixture = { researchedAt: string; candidates: Candidate[] };
const fixture: Fixture = JSON.parse(readFileSync(new URL('../../docs/examples/research-result.json', import.meta.url), 'utf8'));

// Provided by the simulated recipient, independently of the research artifact.
export const demoPermission = { recipient: 'partnerships@coffee-studio.example', purpose: 'coffee partnership', grantedBy: 'Synthetic test recipient' };
const brief = 'Find Japanese-speaking creators with a recent pour-over tutorial and a published partnership contact.';

export function assessCandidate(candidate: Candidate, asOf: string) {
  const age = Date.parse(asOf.slice(0, 10)) - Date.parse(candidate.work.publishedOn ?? '');
  if (candidate.language !== 'ja' || !Number.isFinite(age) || age < 0 || age > 90 * 86400000)
    return { status: 'outside_brief' as const, candidate };
  const contact = candidate.contacts.find(c => c.source === 'public_business_page' && c.evidenceUrl.startsWith('https://')
    && c.address.length > 0 && c.evidenceExcerpt.includes(c.address));
  if (!contact) return { status: 'missing_evidence' as const, candidate };
  if (contact.address !== demoPermission.recipient) return { status: 'missing_permission' as const, candidate };
  return { status: 'eligible' as const, candidate, contact };
}

export function prepareSampleCampaign() {
  // Use the fixture's capture date so replay gives the same answer next month.
  const assessed = fixture.candidates.map(candidate => assessCandidate(candidate, fixture.researchedAt));
  const eligible = assessed.find(row => row.status === 'eligible');
  if (!eligible) throw new Error('The demo fixture has no eligible creator.');
  const { contact, candidate } = eligible;
  const research = assessed.map(row => ({ creator: row.candidate.displayName, status: row.status }));
  const draft = {
    creator: candidate.displayName, source: contact.evidenceUrl, evidence: contact.evidenceExcerpt,
    work: candidate.work.url, from: 'partnerships@team.example', to: contact.address,
    subject: '手淹れコーヒーの共同企画について',
    body: candidate.displayName + ' 様\n\nハンドドリップのチュートリアルを拝見しました。新しいコーヒーの抽出方法を一緒に紹介する企画にご興味はありますか。\n\nMailoop Coffee Team',
    permission: demoPermission, mode: 'simulated', research
  };
  return { brief, draft };
}
