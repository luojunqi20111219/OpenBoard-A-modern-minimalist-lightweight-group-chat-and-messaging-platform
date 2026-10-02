/**
 * 本地 scrypt 哈希验证 / 转码工具
 *
 * 用途：旧库里的 scrypt 哈希在 Cloudflare Free 计划下无法验证
 * （N=32768 需 ~75ms CPU，Free 每请求上限 10ms）。
 * 这个脚本在本地跑，拿明文密码确认哈希正确后，
 * 产出 Cloudflare 能验证的 pbkdf2:sha256:10000 哈希，写回 D1。
 *
 * 用法：
 *   node scripts/rehash-local.mjs <username> <明文密码>
 *     验证该用户的 scrypt 哈希是否匹配，并打印可写回 D1 的新哈希
 *
 *   node scripts/rehash-local.mjs --selftest
 *     用 RFC 7914 官方向量自检
 */
import { scrypt as wasmScrypt } from 'hash-wasm';
import { webcrypto as crypto } from 'node:crypto';

const D1_TOKEN = process.env.CF_API_TOKEN || '';
const D1_ACC = process.env.CF_ACCOUNT_ID || '';
const D1_ID = process.env.CF_D1_ID || '1f6015cb-09ba-490c-b083-145a7be040db';

const enc = new TextEncoder();
const toHex = (b) => {
  let o = '';
  for (let i = 0; i < b.length; i++) o += b[i].toString(16).padStart(2, '0');
  return o;
};
const fromHex = (s) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};

/** 解析 werkzeug 哈希串 → { algo, params, salt, hashHex } */
function parseWerkzeugHash(stored) {
  const parts = stored.split('$');
  if (parts.length !== 3) throw new Error('哈希格式非法（应为 method$salt$hash）');
  const [method, salt, hashHex] = parts;
  const seg = method.split(':');
  if (seg[0] === 'scrypt') {
    const [, n, r, p] = seg;
    return {
      algo: 'scrypt',
      N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10),
      salt,         // scrypt 的盐是 ASCII 字符串，不是 hex
      hashHex,
    };
  }
  if (seg[0] === 'pbkdf2') {
    const [, digest, iter] = seg;
    return { algo: 'pbkdf2', digest, iterations: parseInt(iter, 10), salt, hashHex };
  }
  throw new Error(`不支持的算法：${seg[0]}`);
}

/** 验证 scrypt 哈希 */
async function verifyScrypt(password, parsed) {
  const { N, r, p, salt, hashHex } = parsed;
  const dk = await wasmScrypt({
    password: enc.encode(password),
    salt: enc.encode(salt),
    costFactor: N,
    blockSize: r,
    parallelism: p,
    hashLength: hashHex.length / 2,
    outputType: 'binary',
  });
  const got = toHex(dk);
  return { ok: got === hashHex, got, exp: hashHex };
}

/** 验证 pbkdf2 哈希 */
async function verifyPbkdf2(password, parsed) {
  const { digest, iterations, salt, hashHex } = parsed;
  const keyLen = hashHex.length / 2;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: digest === 'sha256' ? 'SHA-256' : digest.toUpperCase() },
    key, keyLen * 8,
  );
  const got = toHex(new Uint8Array(bits));
  return { ok: got === hashHex, got, exp: hashHex };
}

/** 生成 Cloudflare Free 计划可验证的 pbkdf2 哈希（16 字节 salt，与 werkzeug 同格式） */
async function makePbkdf2Hash(password, iterations = 10000) {
  const SALT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let salt = '';
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  for (const b of rnd) salt += SALT_CHARS[b % SALT_CHARS.length];
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    key, 32 * 8,
  );
  return `pbkdf2:sha256:${iterations}$${salt}$${toHex(new Uint8Array(bits))}`;
}

async function fetchHash(username) {
  if (!D1_TOKEN || !D1_ACC) throw new Error('需设置 CF_API_TOKEN / CF_ACCOUNT_ID 环境变量');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${D1_ACC}/d1/database/${D1_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${D1_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT username, password_hash FROM users WHERE username = ?', params: [username] }),
    },
  );
  const d = await res.json();
  if (!d.success) throw new Error(JSON.stringify(d.errors));
  return d.result[0].results[0] || null;
}

// ---------------------------------------------------------------------------
const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === '--selftest') {
  console.log('=== RFC 7914 官方向量自检 ===');
  const cases = [
    { pw: '', salt: '', N: 16, r: 1, p: 1, hashHex: '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906' },
    { pw: 'password', salt: 'NaCl', N: 1024, r: 8, p: 16, hashHex: 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640' },
    { pw: 'pleaseletmein', salt: 'SodiumChloride', N: 16384, r: 8, p: 1, hashHex: '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887' },
  ];
  let bad = 0;
  for (const c of cases) {
    const res = await verifyScrypt(c.pw, { N: c.N, r: c.r, p: c.p, salt: c.salt, hashHex: c.hashHex });
    console.log(`  N=${c.N} r=${c.r} p=${c.p} → ${res.ok ? 'PASS' : 'FAIL'}`);
    if (!res.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

if (cmd && !cmd.startsWith('--')) {
  const username = cmd;
  const password = arg1;
  if (!password) {
    console.error('用法：node scripts/rehash-local.mjs <username> <明文密码>');
    process.exit(1);
  }
  const row = await fetchHash(username);
  if (!row) {
    console.error(`D1 里找不到用户：${username}`);
    process.exit(1);
  }
  console.log(`用户：${row.username}`);
  const parsed = parseWerkzeugHash(row.password_hash);
  console.log(`算法：${parsed.algo} ${parsed.N ? `N=${parsed.N} r=${parsed.r} p=${parsed.p}` : `${parsed.digest} x${parsed.iterations}`}`);

  const t0 = performance.now();
  const res = parsed.algo === 'scrypt'
    ? await verifyScrypt(password, parsed)
    : await verifyPbkdf2(password, parsed);
  const cost = (performance.now() - t0).toFixed(1);

  if (!res.ok) {
    console.log(`\n❌ 密码不匹配（耗时 ${cost}ms）`);
    console.log(`   期望 ${res.exp.slice(0, 32)}...`);
    console.log(`   实际 ${res.got.slice(0, 32)}...`);
    process.exit(2);
  }

  console.log(`\n✅ 密码正确（本机耗时 ${cost}ms）`);
  const newHash = await makePbkdf2Hash(password, 10000);
  console.log('\n可写回 D1 的新哈希（Cloudflare Free 计划可直接验证）：');
  console.log(newHash);
  console.log('\n写回命令：');
  console.log(`  UPDATE users SET password_hash = '${newHash}' WHERE username = '${username}';`);
  process.exit(0);
}

console.log(`用法：
  node scripts/rehash-local.mjs --selftest              # 自检
  node scripts/rehash-local.mjs <username> <明文密码>    # 验证并生成新哈希
`);
