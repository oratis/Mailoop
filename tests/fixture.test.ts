import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCandidate, demoPermission, prepareSampleCampaign } from '../packages/agent/coffee-fixture.ts';

test('research decisions preserve the distinction between evidence and permission', () => {
  const asOf = '2026-11-19T09:00:00Z';
  const contact = { source: 'public_business_page', evidenceUrl: 'https://studio.example/contact',
    address: demoPermission.recipient, evidenceExcerpt: demoPermission.recipient };
  const creator = { displayName: 'Studio', language: 'ja', work: { url: 'https://studio.example/works', publishedOn: '2026-08-21' }, contacts: [contact] };
  assert.equal(assessCandidate(creator, asOf).status, 'eligible');
  assert.equal(assessCandidate({ ...creator, work: { ...creator.work, publishedOn: '2026-08-20' } }, asOf).status, 'outside_brief');
  assert.equal(assessCandidate({ ...creator, contacts: [] }, asOf).status, 'missing_evidence');
  const alternate = 'agency@studio.example';
  assert.equal(assessCandidate({ ...creator, contacts: [{ ...contact, address: alternate, evidenceExcerpt: alternate }] }, asOf).status, 'missing_permission');
  assert.deepEqual(prepareSampleCampaign().draft.research.map(row => row.status), ['eligible', 'missing_evidence']);
});
