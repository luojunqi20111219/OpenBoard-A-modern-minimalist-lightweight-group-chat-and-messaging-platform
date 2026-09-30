#!/usr/bin/env node
/**
 * 生产环境 WebSocket 端到端测试
 *
 * 为什么需要它：本地 Miniflare 与线上 Cloudflare 的运行时不等价。
 * 早期 Pages 方案正是「本地全绿、线上 500 error 1101」——
 * 因为带 webSocket 的 101 响应无法穿过 Pages → DO 的服务绑定边界。
 * 因此必须在**真实生产域名**上验证握手与广播。
 *
 * 沙箱把 *.luojunqi.xyz 的 DNS 劫持了，所以这里用 lookup 强制解析到
 * 真实 Cloudflare 边缘 IP（104.17.2.229）。
 *
 * 用法：node scripts/live-ws-test.mjs [host]
 */
import WebSocket from 'ws';
import https from 'https';

const HOST = process.argv[2] || 'openboard.luojunqi.xyz';
const EDGE_IP = '104.17.2.229'; // 沙箱可通的 CF 边缘 IP

// Node 22 的 lookup 回调：当 options.all 为真时必须返回数组，否则返回单条。
// 两个分支都实现，否则会抛 ERR_INVALID_IP_ADDRESS。
const lookup = (_hostname, options, cb) => {
  if (options && options.all) {
    cb(null, [{ address: EDGE_IP, family: 4 }]);
  } else {
    cb(null, EDGE_IP, 4);
  }
};

const agent = new https.Agent({ lookup, keepAlive: true });

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const no = (m) => { fail++; console.log(`  ❌ ${m}`); };

function api(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        path,
        method: opts.method || 'GET',
        agent,
        headers: { Host: HOST, ...(opts.headers || {}) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, body: d, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${HOST}${path}`, {
      agent,
      headers: { Host: HOST },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('握手超时'));
    }, 15000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 100)}`)));
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n════════ 生产环境 WebSocket 测试 @ ${HOST} ════════\n`);

  // --- 准备两个测试账号 ---------------------------------------------------
  const stamp = Date.now();
  const users = [`wsA_${stamp}`, `wsB_${stamp}`];
  const tokens = [];

  console.log('【0】注册测试账号');
  for (const u of users) {
    const r = await api('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'WsTest!2026x', nickname: u }),
    });
    if (r.status === 200 && r.json?.token) {
      tokens.push(r.json.token);
      ok(`注册 ${u} → HTTP ${r.status}`);
    } else {
      no(`注册 ${u} 失败: HTTP ${r.status} ${r.body.slice(0, 120)}`);
    }
  }
  if (tokens.length < 2) {
    console.log('\n测试账号创建不全，中止');
    process.exit(1);
  }

  // --- 1. 健康检查 --------------------------------------------------------
  console.log('\n【1】健康检查');
  {
    const r = await api('/api/health');
    r.status === 200 && r.json?.status === 'ok'
      ? ok(`/api/health → 200 ${JSON.stringify(r.json)}`)
      : no(`/api/health → ${r.status} ${r.body.slice(0, 120)}`);
  }

  // --- 2. WebSocket 握手（两条路径）---------------------------------------
  console.log('\n【2】WebSocket 握手');
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connect(`/api/ws/${tokens[0]}`);
    ok(`/api/ws/{token} 握手成功 (readyState=${wsA.readyState})`);
  } catch (e) {
    no(`/api/ws/{token} 握手失败: ${e.message}`);
  }

  try {
    wsB = await connect(`/ws/${tokens[1]}`);
    ok(`/ws/{token} 握手成功（旧版安卓路径, readyState=${wsB.readyState}）`);
  } catch (e) {
    no(`/ws/{token} 握手失败: ${e.message}`);
  }

  // --- 3. 连接后收到 online_status ----------------------------------------
  console.log('\n【3】连接后收到 online_status');
  if (wsB) {
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      wsB.on('message', (raw) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(raw.toString())); } catch { resolve(null); }
      });
    });
    got?.type === 'online_status'
      ? ok(`收到 online_status: ${JSON.stringify(got.users)}`)
      : no(`未收到 online_status（收到: ${JSON.stringify(got)}）`);
  } else {
    no('wsB 未连接，跳过');
  }

  // --- 3.5 建立好友关系（私聊前置条件）------------------------------------
  //
  // ⚠️ /api/messages 的私聊分支有好友校验，非好友直接 403。
  //    不先加好友，第 4 步的广播测试必然收不到消息。
  console.log('\n【3.5】建立好友关系');
  {
    const r = await api('/api/friends/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens[0]}`,
      },
      body: JSON.stringify({ username: users[1] }),
    });
    r.status === 200
      ? ok(`A 添加 B 为好友 → 200 ${r.body.slice(0, 80)}`)
      : no(`加好友失败 → ${r.status} ${r.body.slice(0, 120)}`);
  }

  // --- 4. 跨连接实时广播 --------------------------------------------------
  console.log('\n【4】跨连接实时广播');
  if (wsA && wsB) {
    const payload = `广播验证-${stamp}`;

    const received = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 12000);
      wsB.on('message', (raw) => {
        let m = null;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m?.type === 'message' && JSON.stringify(m).includes(payload)) {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });

    // 短暂等待，确保好友关系已写入 D1
    await wait(800);

    // A 发消息给 B
    const send = await api('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens[0]}`,
      },
      body: JSON.stringify({ receiver: users[1], content: payload }),
    });
    send.status === 200
      ? ok(`A 发送消息 → 200 ${send.body.slice(0, 80)}`)
      : no(`A 发送消息失败 → ${send.status} ${send.body.slice(0, 140)}`);

    const msg = await received;
    msg ? ok(`B 实时收到 A 的消息: ${JSON.stringify(msg.message ?? msg).slice(0, 120)}`)
        : no('B 未在 12 秒内收到广播推送');
  } else {
    no('存在未连接的 WS，跳过广播测试');
  }

  // --- 5. 在线状态 -------------------------------------------------------
  console.log('\n【5】在线状态');
  {
    // /api/online 不存在，真实入口是健康检查里的 online_count
    const r = await api('/api/health');
    typeof r.json?.online_count === 'number' && r.json.online_count >= 1
      ? ok(`/api/health online_count=${r.json.online_count}（有在线连接）`)
      : no(`online_count 异常: ${JSON.stringify(r.json)}`);
  }

  // --- 清理 -------------------------------------------------------------
  try { wsA?.close(); } catch { /* ignore */ }
  try { wsB?.close(); } catch { /* ignore */ }
  await wait(500);

  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`（测试账号 ${users.join(', ')} 需手动清理）`);
  console.log('─'.repeat(52) + '\n');

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
