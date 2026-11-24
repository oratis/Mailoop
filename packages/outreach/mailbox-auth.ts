import { connector } from '../connectors/sdk.ts';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { asWorkspace, RequestError } from '../db/database.ts';
import { type Context, type Input, requireRole, program, lockWorkspace } from './context.ts';
import { address, field, id, instant, integer, Vault } from './security.ts';
export type OAuthProvider = 'gmail' | 'graph' | 'feishu' | 'nylas';
export type Tokens = {
  access: string;
  refresh: string;
  expires: number;
  scope?: string;
  grantId?: string;
  email?: string;
};
type ProviderConfig = {
  auth: string;
  token: string;
  refresh: string;
  scope: string;
  id: string;
  secret: string;
};
export const nylasOrigin = () =>
  process.env.MAILOOP_NYLAS_REGION === 'eu' ? 'https://api.eu.nylas.com' : 'https://api.us.nylas.com';
export function providerConfig(provider: string): ProviderConfig {
  const prefix = provider.toUpperCase(),
    client = process.env['MAILOOP_' + prefix + '_CLIENT_ID'],
    secret = process.env['MAILOOP_' + prefix + '_CLIENT_SECRET'];
  if (!client || !secret)
    throw new RequestError(503, 'Configure the ' + provider + ' OAuth application.');
  const configs: Record<OAuthProvider, [string, string, string, string]> = {
    nylas: [
      nylasOrigin() + '/v3/connect/auth',
      nylasOrigin() + '/v3/connect/token',
      nylasOrigin() + '/v3/connect/token',
      ''
    ],
    gmail: [
      'https://accounts.google.com/o/oauth2/v2/auth',
      'https://oauth2.googleapis.com/token',
      'https://oauth2.googleapis.com/token',
      'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly'
    ],
    graph: [
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      'offline_access User.Read Mail.Read Mail.Send'
    ],
    feishu: [
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      'https://accounts.feishu.cn/oauth/v3/token',
      'offline_access mail:user_mailbox:readonly mail:user_mailbox.message:readonly mail:user_mailbox.message.subject:read mail:user_mailbox.message.address:read mail:user_mailbox.message.body:read mail:user_mailbox.message:modify mail:user_mailbox.message:send'
    ]
  };
  const c = configs[provider as OAuthProvider];
  if (!c) throw new RequestError(422, 'Unsupported OAuth provider.');
  return { auth: c[0], token: c[1], refresh: c[2], scope: c[3], id: client, secret };
}
export class MailboxError extends RequestError {
  readonly retryAfterMs: number;
  constructor(status: number, header: string | null) {
    super(status, 'Mailbox provider returned ' + status);
    const delay =
      header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? '') - Date.now();
    this.retryAfterMs = Number.isFinite(delay) ? Math.max(0, delay) : 0;
  }
}
export async function remoteJSON(url: string, token: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + token, ...init.headers }
  });
  if (!r.ok) throw new MailboxError(r.status, r.headers.get('retry-after'));
  if (r.status === 204 || r.status === 202) return {};
  const d = await r.json();
  if (d.code !== undefined && d.code !== 0)
    throw new RequestError(422, 'Mailbox provider rejected this operation.');
  return d;
}
async function tokens(provider: string, params: Record<string, string>, old?: Tokens): Promise<Tokens> {
  const c = providerConfig(provider),
    refresh = params.grant_type === 'refresh_token',
    json = (provider === 'feishu' && !refresh) || provider === 'nylas';
  const fields = { ...params, client_id: c.id, client_secret: c.secret };
  const r = await fetch(refresh ? c.refresh : c.token, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields)
  });
  if (!r.ok) throw new RequestError(401, 'Mailbox authorization requires reconnection.');
  const d = await r.json();
  if (typeof d.access_token !== 'string')
    throw new RequestError(401, 'Mailbox did not issue an access token.');
  return {
    access: d.access_token,
    refresh: d.refresh_token ?? old?.refresh ?? '',
    expires: Date.now() + 1000 * (Number(d.expires_in) || 3600),
    scope: d.scope ?? old?.scope,
    grantId: d.grant_id ?? old?.grantId,
    email: d.email ?? old?.email
  };
}
export async function startOAuth(ctx: Context, b: Input) {
  requireRole(ctx, 'reviewer', 'operator');
  const provider = field(b.provider, 'provider'),
    c = providerConfig(provider);
  const verifier = randomBytes(32).toString('base64url');
  const result = await ctx.db.query(
    `INSERT INTO oauth_states(workspace_id,owner_id,provider,secret,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '10 minutes') RETURNING id`,
    [ctx.member.workspaceId, ctx.member.id, provider, ctx.vault.seal(ctx.member.workspaceId, verifier)]
  );
  const url = new URL(c.auth),
    state = ctx.vault.token('oauth', ctx.member.workspaceId + '/' + result.rows[0].id);
  const params = {
    client_id: c.id,
    redirect_uri: ctx.base + '/oauth/' + provider + '/callback',
    response_type: 'code',
    scope: c.scope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  };
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  if (provider === 'nylas') url.searchParams.set('access_type', 'offline');
  if (provider === 'gmail') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return { url: url.href };
}
export async function oauthCallback(
  pool: Pool,
  vault: Vault,
  base: string,
  provider: string,
  state: string,
  code: string
) {
  const [ws, stateId] = vault.verify('oauth', state).split('/').map(id);
  return asWorkspace(pool, ws, async (db) => {
    const {
      rows: [s]
    } = await db.query(
      `DELETE FROM oauth_states WHERE id=$1 AND provider=$2 AND expires_at>now()
      AND EXISTS(SELECT 1 FROM active_members WHERE id=oauth_states.owner_id) RETURNING *`,
      [stateId, provider]
    );
    if (!s) throw new RequestError(400, 'Expired or already used connection.');
    const t = await tokens(provider, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: base + '/oauth/' + provider + '/callback',
      code_verifier: vault.open(ws, s.secret)
    });
    let account: string, email: string;
    if (provider === 'gmail') {
      const d = await remoteJSON('https://openidconnect.googleapis.com/v1/userinfo', t.access);
      if (!d.email_verified) throw new RequestError(422, 'Google has not verified this identity.');
      account = d.sub;
      email = address(d.email);
    } else if (provider === 'graph') {
      const d = await remoteJSON(
        'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName',
        t.access
      );
      account = d.id;
      email = address(d.mail ?? d.userPrincipalName);
    } else if (provider === 'nylas') {
      account = field(t.grantId, 'grant ID');
      email = address(t.email);
    } else {
      const d = (await remoteJSON('https://open.feishu.cn/open-apis/authen/v1/user_info', t.access))
        .data;
      const a =
        (
          await remoteJSON(
            'https://open.feishu.cn/open-apis/mail/v1/user_mailboxes/me/settings/send_as',
            t.access
          )
        ).data?.sendable_addresses ?? [];
      account = d.open_id;
      email = address(d.enterprise_email ?? d.email ?? a[0]?.email_address);
      if (
        !a.some((x: { email_address: string }) => x.email_address?.toLowerCase() === email.toLowerCase())
      )
        throw new RequestError(422, 'Mailbox identity is not authorized to send.');
    }
    return saveMailbox(db, vault, ws, s.owner_id, provider, field(account, 'account ID'), email, t, 50);
  });
}
export type BasicMailbox = {
  user: string;
  password: string;
  smtpHost: string;
  imapHost: string;
  smtpPort: number;
  imapPort: number;
  grantId?: string;
};
async function saveMailbox(
  db: PoolClient,
  vault: Vault,
  ws: string,
  owner: string,
  provider: string,
  account: string,
  email: string,
  credentials: unknown,
  cap: number
) {
  const {
    rows: [r]
  } = await db.query(
    `INSERT INTO mailboxes(workspace_id,owner_id,provider,account_key,address,secret,cap)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,provider,account_key) DO UPDATE SET
    secret=excluded.secret,address=excluded.address,active=true,version=mailboxes.version+1,cap=excluded.cap
    WHERE mailboxes.owner_id=excluded.owner_id RETURNING id,provider,active,cap`,
    [
      ws,
      owner,
      provider,
      vault.hash(ws, account),
      vault.seal(ws, email),
      vault.seal(ws, credentials),
      cap
    ]
  );
  if (!r) throw new RequestError(409, 'Account already belongs to another member.');
  return r;
}
export async function directMailbox(ctx: Context, b: Input) {
  requireRole(ctx, 'reviewer', 'operator');
  const email = address(b.address),
    provider = field(b.provider, 'provider'),
    cap = integer(b.cap ?? 50, 'mailbox cap', 1, 500);
  let credentials: unknown = {};
  if (provider === 'simulated') {
    if (!email.endsWith('.example')) throw new RequestError(422, 'Use a .example simulator identity.');
    credentials = { loseReceipt: b.loseReceipt === true };
  } else if (provider === 'smtp') {
    const allowed = (process.env.MAILOOP_MAIL_HOSTS ?? '').split(',').filter(Boolean);
    const smtpHost = field(b.smtpHost, 'SMTP host'),
      imapHost = field(b.imapHost, 'IMAP host');
    if (!allowed.includes(smtpHost) || !allowed.includes(imapHost))
      throw new RequestError(422, 'Mail host not configured by deployment owner.');
    const cfg = {
      user: email,
      password: field(b.password, 'application password', 1500),
      smtpHost,
      imapHost,
      smtpPort: 465,
      imapPort: 993
    };
    const { verifyBasic } = await import('./mail-transports.ts');
    await verifyBasic(cfg);
    credentials = cfg;
  } else if (connector(provider)) {
    const v = await connector(provider)!.verify(b);
    return saveMailbox(
      ctx.db,
      ctx.vault,
      ctx.member.workspaceId,
      ctx.member.id,
      provider,
      field(v.accountId, 'provider account'),
      address(v.address),
      v.credentials,
      cap
    );
  } else throw new RequestError(422, 'Use OAuth for this provider.');
  return saveMailbox(
    ctx.db,
    ctx.vault,
    ctx.member.workspaceId,
    ctx.member.id,
    provider,
    email,
    email,
    credentials,
    cap
  );
}
export async function grantMailbox(ctx: Context, mailbox: string, b: Input) {
  await lockWorkspace(ctx);
  const owner = (
    await ctx.db.query('SELECT * FROM mailboxes WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      mailbox,
      ctx.member.id
    ])
  ).rows[0];
  if (!owner) throw new RequestError(404, 'Owned mailbox not found.');
  if (b.action === 'disconnect') {
    await ctx.db.query("UPDATE mailboxes SET active=false,version=version+1,secret='' WHERE id=$1", [
      mailbox
    ]);
    await ctx.db.query('DELETE FROM delegations WHERE mailbox_id=$1', [mailbox]);
    return { active: false };
  }
  const campaign = id(b.campaignId);
  await program(ctx, campaign);
  if (b.action === 'revoke')
    await ctx.db.query('DELETE FROM delegations WHERE mailbox_id=$1 AND program_id=$2', [
      mailbox,
      campaign
    ]);
  else {
    const expires = instant(b.expiresAt);
    if (expires <= new Date() || !owner.active)
      throw new RequestError(422, 'A current, active grant is required.');
    await ctx.db.query(
      `INSERT INTO delegations(workspace_id,mailbox_id,program_id,expires_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,mailbox_id,program_id) DO UPDATE SET expires_at=excluded.expires_at`,
      [ctx.member.workspaceId, mailbox, campaign, expires]
    );
  }
  await ctx.db.query('UPDATE mailboxes SET version=version+1 WHERE id=$1', [mailbox]);
  return { ok: true };
}
export async function accessMailbox(db: PoolClient, vault: Vault, ws: string, mailbox: string) {
  const m = (await db.query('SELECT * FROM mailboxes WHERE id=$1 AND active FOR UPDATE', [mailbox]))
    .rows[0];
  if (!m) throw new RequestError(401, 'Mailbox unavailable.');
  m.email = vault.open(ws, m.address);
  if (['gmail', 'graph', 'feishu', 'nylas'].includes(m.provider)) {
    let t = vault.open<Tokens>(ws, m.secret);
    if (t.expires - Date.now() < 90000) {
      t = await tokens(m.provider, { grant_type: 'refresh_token', refresh_token: t.refresh }, t);
      await db.query('UPDATE mailboxes SET secret=$2 WHERE id=$1', [m.id, vault.seal(ws, t)]);
    }
    m.token = t.access;
  } else m.basic = vault.open(ws, m.secret);
  return m;
}
