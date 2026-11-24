import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RequestError } from '../db/database.ts';

export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('MAILOOP_MASTER_KEY must decode to exactly 32 bytes.');
  }
  private derive(scope: string, purpose: string) {
    return createHmac('sha256', this.key)
      .update(purpose + '/' + scope)
      .digest();
  }
  seal(scope: string, value: unknown): string {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.derive(scope, 'encrypt'), nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), data].map((x) => x.toString('base64url')).join('.');
  }
  open<T>(scope: string, sealed: string): T {
    const [nonce, tag, data] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', this.derive(scope, 'encrypt'), nonce);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
  }
  hash(scope: string, value: string) {
    return createHmac('sha256', this.derive(scope, 'lookup')).update(value).digest('hex');
  }
  token(scope: string, value: string) {
    const data = Buffer.from(value).toString('base64url');
    return data + '.' + this.hash(scope, data);
  }
  verify(scope: string, token: string) {
    const [data, mac] = token.split('.');
    const expected = this.hash(scope, data ?? '');
    if (!mac || !/^[0-9a-f]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
      throw new RequestError(400, 'Invalid signed link.');
    return Buffer.from(data, 'base64url').toString();
  }
}
export function field(value: unknown, name: string, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new RequestError(422, 'Invalid ' + name);
  return value.trim();
}
export function id(value: unknown) {
  const v = field(value, 'id', 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v))
    throw new RequestError(422, 'Invalid resource ID.');
  return v;
}
export function integer(value: unknown, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new RequestError(422, 'Invalid ' + name);
  return Number(value);
}
export function address(value: unknown) {
  const v = field(value, 'email', 254);
  if (!/^[^\s<>@,;\r\n]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v))
    throw new RequestError(422, 'Invalid email address.');
  const [local, domain] = v.split('@');
  return local + '@' + domain.toLowerCase();
}
export function instant(value: unknown) {
  const time = Date.parse(field(value, 'date', 50));
  if (!Number.isFinite(time)) throw new RequestError(422, 'Invalid date.');
  return new Date(time);
}
