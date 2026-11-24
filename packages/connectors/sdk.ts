import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Envelope, InboundMail } from '../outreach/mail-transports.ts';

export interface MailboxExtension {
  apiVersion: 1;
  id: string;
  name: string;
  verify(
    input: Record<string, unknown>
  ): Promise<{ accountId: string; address: string; credentials: Record<string, unknown> }>;
  submit(credentials: Record<string, unknown>, message: Envelope, raw: Buffer): Promise<string>;
  reconcile(credentials: Record<string, unknown>, rfcMessageId: string): Promise<string | undefined>;
  replies(
    credentials: Record<string, unknown>,
    receipt: string,
    rfcMessageId: string
  ): Promise<InboundMail[]>;
}
const registry = new Map<string, MailboxExtension>();
export function registerConnector(plugin: MailboxExtension) {
  if (
    plugin.apiVersion !== 1 ||
    !/^ext-[a-z0-9-]{1,50}$/.test(plugin.id) ||
    registry.has(plugin.id) ||
    ![plugin.verify, plugin.submit, plugin.reconcile, plugin.replies].every(
      (fn) => typeof fn === 'function'
    )
  )
    throw Error('Invalid or duplicate mailbox extension.');
  registry.set(plugin.id, plugin);
}
export const connector = (provider: string) => registry.get(provider);
const builtins = [
  {
    id: 'gmail',
    name: 'Gmail',
    auth: 'oauth',
    sync: 'Gmail history and thread lookup',
    cloudDraft: false
  },
  { id: 'feishu', name: 'Feishu Mail', auth: 'oauth', sync: 'Paged time windows', cloudDraft: true },
  {
    id: 'graph',
    name: 'Microsoft 365',
    auth: 'oauth',
    sync: 'Graph delta and conversation lookup',
    cloudDraft: false
  },
  { id: 'nylas', name: 'Nylas', auth: 'oauth', sync: 'Hosted thread API', cloudDraft: false },
  {
    id: 'smtp',
    name: 'SMTP and IMAP',
    auth: 'app-password',
    sync: 'IMAP references search',
    cloudDraft: false
  },
  {
    id: 'simulated',
    name: 'Local simulator',
    auth: 'local',
    sync: 'Durable fixture receipts',
    cloudDraft: false
  }
];
export function installedConnectors() {
  return [
    ...builtins.map((c) => ({
      ...c,
      configured:
        c.auth === 'oauth'
          ? Boolean(
              process.env['MAILOOP_' + c.id.toUpperCase() + '_CLIENT_ID'] &&
                process.env['MAILOOP_' + c.id.toUpperCase() + '_CLIENT_SECRET']
            )
          : c.id === 'simulated' || !!process.env.MAILOOP_MAIL_HOSTS
    })),
    ...Array.from(registry.values(), ({ id, name }) => ({
      id,
      name,
      auth: 'extension',
      sync: 'Extension lookup',
      configured: true
    }))
  ];
}
export async function loadExtensions(list = process.env.MAILOOP_CONNECTOR_MODULES ?? '') {
  for (const entry of list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const module = await import(pathToFileURL(resolve(entry)).href);
    registerConnector(module.default);
  }
}
