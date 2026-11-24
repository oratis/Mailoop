import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  verifyBasic,
  submitMail,
  messageId,
  readRelated
} from '../packages/outreach/mail-transports.ts';
const account = (email: string) => ({
  email,
  provider: 'smtp',
  basic: {
    smtpHost: '127.0.0.1',
    imapHost: '127.0.0.1',
    smtpPort: 3465,
    imapPort: 3993,
    user: email,
    password: 'mailtest'
  }
});
const a = account('alice@brand.example'),
  b = account('bob@creator.example');
const outbound = {
  id: randomUUID(),
  subject: 'Local QA',
  body: 'Synthetic partnership inquiry',
  from: a.email,
  to: b.email,
  unsubscribe: 'https://brand.example/unsubscribe/synthetic'
};
await verifyBasic(a.basic);
await verifyBasic(b.basic);
const receipt = await submitMail(a, outbound);
assert.equal(receipt, messageId(outbound.id, a.email));
const imap = new ImapFlow({
  host: b.basic.imapHost,
  port: b.basic.imapPort,
  secure: true,
  auth: { user: b.email, pass: b.basic.password },
  logger: false
});
try {
  await imap.connect();
  await imap.mailboxOpen('INBOX', { readOnly: true });
  const msg = await imap.fetchOne('*', { source: true });
  assert.ok(msg && msg.source);
  const parsed = await simpleParser(msg.source);
  assert.equal(parsed.messageId, receipt);
  assert.match(msg.source.toString(), /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r?$/im);
  assert.ok(msg.source.toString().includes(outbound.unsubscribe));
} finally {
  if (imap.usable) await imap.logout();
}
const response = {
  ...outbound,
  id: randomUUID(),
  from: b.email,
  to: a.email,
  parent: receipt,
  subject: 'Re: Local QA',
  body: 'Interested in a local test'
};
await submitMail(b, response);
const replies = await readRelated(a, { id: outbound.id, receipt, accepted_at: new Date() }, b.email);
assert.equal(replies.length, 1);
assert.ok(replies[0].text.includes(response.body));
assert.equal(replies[0].rfcMessageId, messageId(response.id, b.email));
console.log(
  'TLS SMTP/IMAP delivered one message and associated its reply with the original RFC Message-ID.'
);
