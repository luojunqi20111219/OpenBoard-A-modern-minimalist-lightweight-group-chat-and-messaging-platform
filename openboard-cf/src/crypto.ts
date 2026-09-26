/**
 * 密码哈希 + JWT —— 全部基于 Web Crypto API，零第三方依赖
 * （Workers 运行时没有 werkzeug / PyJWT，FastAPI 那套在这里跑不了）
 */

// ---------------------------------------------------------------------------
// 编码工具
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sha256Hex(text: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', enc.encode(text)).then(toHex);
}

export function randomId(bytes = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------
// 密码哈希
// ---------------------------------------------------------------------------
/**
 * PBKDF2-HMAC-SHA256 迭代次数。
 *
 * ⚠️ Cloudflare Workers 免费套餐单次请求 CPU 上限为 10ms，本函数在免费版上
 * 大概率会因超出 CPU 限额而失败。生产环境请使用付费套餐（CPU 上限 30s），
 * 或把该值调低到 100000（安全性略降但仍在可接受范围）。
 */
export const PASSWORD_ITERATIONS = 210_000;
const KEY_LEN_BYTES = 32;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  keyLen: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    keyLen * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 生成 werkzeug 兼容的密码哈希：`pbkdf2:sha256:<N>$<salt_hex>$<hash_hex>`
 * 保持与原 Python 版一致的格式，便于直接迁移旧库中的用户数据。
 */
export async function hashPassword(
  password: string,
  iterations: number = PASSWORD_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(password, salt, iterations, KEY_LEN_BYTES);
  return `pbkdf2:sha256:${iterations}$${toHex(salt)}$${toHex(dk)}`;
}

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'mismatch' | 'unsupported' };

/**
 * 校验密码。
 * 支持 `pbkdf2:sha256:N$salt$hash`（werkzeug 同格式）。
 * werkzeug 3.x 默认改用 scrypt，Workers 的 Web Crypto 不提供 scrypt，
 * 这类旧哈希会返回 unsupported —— 需要管理员重置密码或用迁移脚本转码。
 */
export async function verifyPassword(password: string, stored: string | null): Promise<PasswordCheck> {
  if (!stored) return { ok: false, reason: 'mismatch' };
  const parts = stored.split('$');
  if (parts.length !== 3) return { ok: false, reason: 'mismatch' };

  const [method, saltHex, hashHex] = parts;
  const [algo, digest, iterStr] = method.split(':');

  if (algo !== 'pbkdf2' || digest !== 'sha256') {
    return { ok: false, reason: 'unsupported' };
  }

  const iterations = parseInt(iterStr || String(PASSWORD_ITERATIONS), 10) || PASSWORD_ITERATIONS;
  const dk = await pbkdf2(password, fromHex(saltHex), iterations, KEY_LEN_BYTES);
  const expected = fromHex(hashHex);

  if (dk.length !== expected.length) return { ok: false, reason: 'mismatch' };
  // 常数时间比较
  let diff = 0;
  for (let i = 0; i < dk.length; i++) diff |= dk[i] ^ expected[i];
  return diff === 0 ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** 旧哈希是否为 Workers 无法验证的格式（如 scrypt） */
export function isUnsupportedHash(stored: string | null): boolean {
  if (!stored) return false;
  const [method] = stored.split('$');
  const [algo] = method.split(':');
  return algo !== 'pbkdf2';
}

// ---------------------------------------------------------------------------
// JWT（HS256）
// ---------------------------------------------------------------------------
export interface JwtPayload {
  username: string;
  jti?: string;
  exp?: number;
  [k: string]: unknown;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(
  payload: JwtPayload,
  secret: string,
  expiresMinutes = 60 * 24 * 7,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = {
    ...payload,
    jti: payload.jti || randomId(12),
    exp: payload.exp ?? now + expiresMinutes * 60,
  };
  const h = toBase64Url(enc.encode(JSON.stringify(header)));
  const p = toBase64Url(enc.encode(JSON.stringify(body)));
  const signingInput = `${h}.${p}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signingInput));
  return `${signingInput}.${toBase64Url(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  if (!token || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const signingInput = `${parts[0]}.${parts[1]}`;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(parts[2]) as BufferSource,
      enc.encode(signingInput) as BufferSource,
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  try {
    const payload = JSON.parse(dec.decode(fromBase64Url(parts[1]))) as JwtPayload;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 未验签地读取 payload，仅用于取 username 做审计等用途 */
export function unsafeDecodeJwt(token: string): JwtPayload | null {
  try {
    return JSON.parse(dec.decode(fromBase64Url(token.split('.')[1]))) as JwtPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TOTP（两步验证，RFC 6238）
// ---------------------------------------------------------------------------
export function generateTotpSecret(): string {
  // Base32 字母表，16 字节 → 26 字符
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

function base32ToBytes(b32: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.substr(i * 8, 8), 2);
  return out;
}

export async function verifyTotp(secret: string, code: string, window = 1): Promise<boolean> {
  const digits = 6;
  const keyBytes = base32ToBytes(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  for (let w = -window; w <= window; w++) {
    const c = counter + w;
    // 64 位大端计数器
    const msg = new Uint8Array(8);
    let tmp = c;
    for (let i = 7; i >= 0; i--) {
      msg[i] = tmp & 0xff;
      tmp = Math.floor(tmp / 256);
    }
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg as BufferSource));
    const offset = mac[mac.length - 1] & 0x0f;
    const bin =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);
    const otp = String(bin % 10 ** digits).padStart(digits, '0');
    if (otp === code.trim()) return true;
  }
  return false;
}
