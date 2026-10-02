/**
 * hash-wasm (WASM) vs @noble/hashes (纯 JS) scrypt 性能对比
 *
 * 决定性实验：salsa 用 WASM 跑能快多少？
 * 目标：把 N=32768 r=8 p=1 压进 Cloudflare Free 的 10ms CPU 预算。
 */
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt.js';
import { scrypt as wasmScrypt } from 'hash-wasm';

const enc = new TextEncoder();
const toHex = (b) => {
  let o = '';
  for (let i = 0; i < b.length; i++) o += b[i].toString(16).padStart(2, '0');
  return o;
};

// ---- 先验证 hash-wasm 正确性（RFC 7914 向量）----
console.log('=== RFC 7914 向量校验（hash-wasm）===');
const cases = [
  { pw: '', salt: '', N: 16, r: 1, p: 1,
    exp: '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906' },
  { pw: 'password', salt: 'NaCl', N: 1024, r: 8, p: 16,
    exp: 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640' },
  { pw: 'pleaseletmein', salt: 'SodiumChloride', N: 16384, r: 8, p: 1,
    exp: '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887' },
];
for (const c of cases) {
  const got = toHex(await wasmScrypt({
    password: enc.encode(c.pw), salt: enc.encode(c.salt),
    costFactor: c.N, blockSize: c.r, parallelism: c.p, hashLength: 64, outputType: 'binary',
  }));
  console.log(`N=${c.N} r=${c.r} p=${c.p} →`, got === c.exp ? 'PASS' : 'FAIL');
  if (got !== c.exp) console.log('  got', got, '\n  exp', c.exp);
}

// ---- 性能对比 ----
console.log('\n=== 性能对比：werkzeug 默认参数 N=32768 r=8 p=1 ===');
const salt = enc.encode('uwbm7JvhPU8UxPzq');

// 预热
await wasmScrypt({ password: enc.encode('warm'), salt, costFactor: 32768, blockSize: 8, parallelism: 1, hashLength: 64, outputType: 'binary' });

for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  await wasmScrypt({ password: enc.encode('bench-pw'), salt, costFactor: 32768, blockSize: 8, parallelism: 1, hashLength: 64, outputType: 'binary' });
  console.log(`  wasm  第 ${i + 1} 次: ${(performance.now() - t0).toFixed(1)} ms`);
}

for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  nobleScrypt(enc.encode('bench-pw'), salt, { N: 32768, r: 8, p: 1, dkLen: 64 });
  console.log(`  noble 第 ${i + 1} 次: ${(performance.now() - t0).toFixed(1)} ms`);
}
