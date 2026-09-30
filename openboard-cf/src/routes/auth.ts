/**
 * 认证相关路由 —— 迁移自 app/routes/auth.py
 * 响应结构与 Python 版保持一致，现有客户端无需改动即可对接。
 */
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin, createAccessToken, revokeToken, isAdmin } from '../auth';
import { qAll, qOne, exec, getUserByName, publicUser, UserRow, nowIso } from '../db';
import {
  hashPassword,
  verifyPassword,
  isUnsupportedHash,
  iterationsOf,
  randomId,
  generateTotpSecret,
  verifyTotp,
  unsafeDecodeJwt,
} from '../crypto';
import { adminList, passwordIterations } from '../env';
import {
  clientIp,
  countryOf,
  loginLockedSeconds,
  recordLoginFailure,
  resetLoginFailures,
} from '../security';
import { cleanText, isValidUsername } from '../sanitize';
import { kickUser } from '../realtime';

export const authRoutes = new Hono<HonoEnv>();

const REMEMBER_SESSION_MINUTES = 60 * 24 * 30;
const BROWSER_SESSION_MINUTES = 60 * 12;

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

function setSessionCookie(c: any, token: string, rememberMe: boolean) {
  setCookie(c, 'token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    ...(rememberMe ? { maxAge: REMEMBER_SESSION_MINUTES * 60 } : {}),
  });
}

async function createSessionToken(
  e: Env,
  user: { id: number; username: string; role: number },
  rememberMe: boolean,
): Promise<string> {
  return createAccessToken(
    e,
    { sub: String(user.id), username: user.username, role: user.role },
    rememberMe ? REMEMBER_SESSION_MINUTES : BROWSER_SESSION_MINUTES,
  );
}

async function registerDeviceSession(
  e: Env,
  opts: {
    userId: number;
    token: string;
    deviceId?: string;
    deviceName?: string;
    userAgent?: string;
    ip?: string;
    country?: string;
  },
): Promise<boolean> {
  const deviceId = (opts.deviceId || '').trim().slice(0, 128);
  if (!deviceId) return false;
  const existed = await qOne(
    e.DB,
    'SELECT 1 AS hit FROM user_devices WHERE user_id=? AND device_id=?',
    opts.userId,
    deviceId,
  );
  await exec(
    e.DB,
    `INSERT INTO user_devices
       (user_id, device_id, token, device_name, user_agent, ip_address, country, last_login, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       token=excluded.token, device_name=excluded.device_name, user_agent=excluded.user_agent,
       ip_address=excluded.ip_address, country=excluded.country,
       last_login=CURRENT_TIMESTAMP, last_seen=CURRENT_TIMESTAMP`,
    opts.userId,
    deviceId,
    opts.token,
    (opts.deviceName || '网页设备').trim().slice(0, 120),
    (opts.userAgent || '').slice(0, 500),
    (opts.ip || '').slice(0, 64),
    (opts.country || '').slice(0, 16),
  );
  return !existed;
}

async function recordLogin(
  e: Env,
  info: {
    userId: number | null;
    username: string;
    deviceId?: string;
    deviceName?: string;
    ip: string;
    country: string;
    userAgent?: string;
    success: boolean;
  },
) {
  await exec(
    e.DB,
    `INSERT INTO login_history
       (user_id, username, device_id, device_name, ip_address, country, user_agent, success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    info.userId,
    info.username,
    info.deviceId ?? null,
    info.deviceName ?? null,
    info.ip,
    info.country,
    (info.userAgent || '').slice(0, 500),
    info.success ? 1 : 0,
  );
}

async function deleteUserAndData(e: Env, userId: number, username: string) {
  const stmts: Array<[string, unknown[]]> = [
    ['DELETE FROM messages WHERE name=?', [username]],
    ['DELETE FROM user_devices WHERE user_id=?', [userId]],
    ['DELETE FROM revoked_sessions WHERE user_id=?', [userId]],
    ['DELETE FROM friends WHERE user_a=? OR user_b=?', [username, username]],
    ['DELETE FROM friend_requests WHERE from_user=? OR to_user=?', [username, username]],
    ['DELETE FROM favorite_emojis WHERE username=?', [username]],
    ['DELETE FROM message_favorites WHERE username=?', [username]],
    ['DELETE FROM conversation_settings WHERE username=?', [username]],
    ['DELETE FROM message_reads WHERE user=?', [username]],
    ['DELETE FROM group_members WHERE username=?', [username]],
    ['DELETE FROM group_join_requests WHERE username=?', [username]],
    ['DELETE FROM group_invites WHERE inviter=? OR invitee=?', [username, username]],
    ['DELETE FROM login_history WHERE user_id=?', [userId]],
    ['DELETE FROM notifications WHERE target_user=?', [username]],
    ['DELETE FROM users WHERE id=?', [userId]],
  ];
  const owned = await qAll<{ id: number }>(e.DB, 'SELECT id FROM groups WHERE owner_id=?', userId);
  for (const g of owned) {
    stmts.push(['DELETE FROM messages WHERE room_id=?', [g.id]]);
    stmts.push(['DELETE FROM groups WHERE id=?', [g.id]]);
  }
  for (const [sql, params] of stmts) {
    await exec(e.DB, sql, ...params);
  }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
authRoutes.post('/register', async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as {
    username?: string;
    password?: string;
    nickname?: string;
    remember_me?: boolean;
    device_id?: string;
    device_name?: string;
  };
  const username = (data.username || '').trim();
  const password = data.password || '';

  if (!isValidUsername(username)) {
    return c.json({ detail: '用户名需为 2-32 位字母、数字、下划线或中文' }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ detail: '密码长度需在 8-128 位之间' }, 400);
  }
  if (await getUserByName(e.DB, username)) {
    return c.json({ detail: '用户名已被占用' }, 400);
  }

  const hashed = await hashPassword(password, passwordIterations(e));
  const nickname = cleanText(data.nickname || username, 64) || username;
  const role = adminList(e).includes(username) ? 1 : 0;

  const res = await exec(
    e.DB,
    'INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, ?)',
    username,
    hashed,
    nickname,
    role,
  );
  const userId = Number(res.meta?.last_row_id ?? 0);

  const token = await createSessionToken(e, { id: userId, username, role }, !!data.remember_me);
  await exec(e.DB, 'UPDATE users SET token=? WHERE id=?', token, userId);
  await registerDeviceSession(e, {
    userId,
    token,
    deviceId: data.device_id,
    deviceName: data.device_name,
    userAgent: c.req.header('User-Agent') || '',
    ip: clientIp(c.req.raw),
    country: countryOf(c.req.raw),
  });
  await recordLogin(e, {
    userId,
    username,
    deviceId: data.device_id,
    deviceName: data.device_name,
    ip: clientIp(c.req.raw),
    country: countryOf(c.req.raw),
    userAgent: c.req.header('User-Agent'),
    success: true,
  });
  await exec(
    e.DB,
    'INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)',
    '欢迎使用信语，开发人员：罗大帅',
    '系统',
    username,
  );

  setSessionCookie(c, token, !!data.remember_me);
  return c.json({
    code: 200,
    token,
    username,
    nickname,
    avatar: null,
    id: userId,
    role,
  });
});

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
authRoutes.post('/login', async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as {
    username?: string;
    password?: string;
    otp?: string;
    remember_me?: boolean;
    device_id?: string;
    device_name?: string;
  };
  const rawUsername = (data.username || '').trim();
  const ip = clientIp(c.req.raw);
  const country = countryOf(c.req.raw);
  const userAgent = c.req.header('User-Agent') || '';

  const accountKey = rawUsername.toLowerCase();
  const locked = await loginLockedSeconds(e, accountKey, ip);
  if (locked > 0) {
    return c.json({ detail: '登录尝试过多，请稍后再试' }, 429, {
      'Retry-After': String(locked),
    });
  }

  const user = await getUserByName(e.DB, rawUsername);

  if (!user) {
    await recordLogin(e, {
      userId: null,
      username: rawUsername,
      deviceId: data.device_id,
      deviceName: data.device_name,
      ip,
      country,
      userAgent,
      success: false,
    });
    const lockSecs = await recordLoginFailure(e, accountKey, ip);
    if (lockSecs > 0) {
      return c.json({ detail: '登录尝试过多，请稍后再试' }, 429, {
        'Retry-After': String(lockSecs),
      });
    }
    return c.json({ detail: '账号或密码错误' }, 401);
  }

  if (user.role === 2) {
    // 系统账号（如文件传输助手）不允许登录
    return c.json({ detail: '账号或密码错误' }, 401);
  }

  if (isUnsupportedHash(user.password_hash)) {
    return c.json(
      { detail: '该账号密码为旧版哈希格式，请联系管理员重置密码后再登录' },
      400,
    );
  }

  // Free 计划单请求 CPU 上限 10ms，验证 210000 次的旧哈希必然超限。
  // 与其抛成没说法的 500，不如提前给出可操作的提示。
  const storedIter = iterationsOf(user.password_hash);
  const targetIter = passwordIterations(e);
  if (storedIter !== null && storedIter > targetIter) {
    return c.json(
      {
        detail:
          `该账号密码哈希使用了 ${storedIter} 次迭代，超出当前运行套餐的 CPU 限额，无法验证。` +
          `请升级到付费套餐（CPU 上限 30s），或联系管理员重置密码。`,
      },
      400,
    );
  }

  const check = await verifyPassword(data.password || '', user.password_hash, targetIter);
  if (!check.ok) {
    await recordLogin(e, {
      userId: user.id,
      username: rawUsername,
      deviceId: data.device_id,
      deviceName: data.device_name,
      ip,
      country,
      userAgent,
      success: false,
    });
    const lockSecs = await recordLoginFailure(e, accountKey, ip);
    if (lockSecs > 0) {
      return c.json({ detail: '登录尝试过多，请稍后再试' }, 429, {
        'Retry-After': String(lockSecs),
      });
    }
    return c.json({ detail: '账号或密码错误' }, 401);
  }

  // 验证通过且强度落后于当前配置 → 趁明文密码在手，静默升级哈希
  if (check.needsRehash) {
    try {
      const upgraded = await hashPassword(data.password || '', targetIter);
      await exec(e.DB, 'UPDATE users SET password_hash=? WHERE id=?', upgraded, user.id);
    } catch {
      // 升级失败不影响本次登录
    }
  }

  if (user.is_banned === 1) {
    return c.json({ detail: '您的账号已被管理员封禁' }, 403);
  }

  if (user.two_factor_enabled === 1) {
    const ok = user.two_factor_secret
      ? await verifyTotp(user.two_factor_secret, data.otp || '')
      : false;
    if (!ok) {
      await recordLogin(e, {
        userId: user.id,
        username: user.username,
        deviceId: data.device_id,
        deviceName: data.device_name,
        ip,
        country,
        userAgent,
        success: false,
      });
      return c.json({ detail: '需要有效的两步验证动态码' }, 401, {
        'X-OpenBoard-2FA': 'required',
      });
    }
  }

  await resetLoginFailures(e, accountKey);

  const token = await createSessionToken(
    e,
    { id: user.id, username: user.username, role: user.role },
    !!data.remember_me,
  );
  await exec(e.DB, 'UPDATE users SET token=? WHERE id=?', token, user.id);

  const hadLogin = await qOne(
    e.DB,
    'SELECT 1 AS hit FROM login_history WHERE user_id=? AND success=1 LIMIT 1',
    user.id,
  );
  const newDevice = await registerDeviceSession(e, {
    userId: user.id,
    token,
    deviceId: data.device_id,
    deviceName: data.device_name,
    userAgent,
    ip,
    country,
  });
  await recordLogin(e, {
    userId: user.id,
    username: user.username,
    deviceId: data.device_id,
    deviceName: data.device_name,
    ip,
    country,
    userAgent,
    success: true,
  });

  if (hadLogin) {
    const knownCountry = country
      ? await qOne(
          e.DB,
          'SELECT 1 AS hit FROM login_history WHERE user_id=? AND success=1 AND country=? LIMIT 1',
          user.id,
          country,
        )
      : null;
    if (newDevice || (country && !knownCountry)) {
      const location = country ? `，地区 ${country}` : '';
      await exec(
        e.DB,
        'INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)',
        `检测到新设备或新地区登录：${data.device_name || '未知设备'}，IP ${ip}${location}`,
        '安全中心',
        user.username,
      );
    }
  }

  setSessionCookie(c, token, !!data.remember_me);
  return c.json({
    code: 200,
    token,
    username: user.username,
    nickname: user.nickname,
    avatar: user.avatar,
    id: user.id,
    role: user.role,
    two_factor_enabled: !!user.two_factor_enabled,
  });
});

// ---------------------------------------------------------------------------
// 登出
// ---------------------------------------------------------------------------
authRoutes.post('/logout', async (c) => {
  const e = env(c);
  const header = c.req.header('Authorization');
  const token = header ? header.replace(/^Bearer\s+/i, '') : (c.req.header('Cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('token='))
    ?.slice(6);

  if (token) {
    const payload = unsafeDecodeJwt(token);
    if (payload?.username) {
      const user = await getUserByName(e.DB, payload.username as string);
      if (user) {
        const device = await qOne<{ device_id: string }>(
          e.DB,
          'SELECT device_id FROM user_devices WHERE user_id=? AND token=?',
          user.id,
          token,
        );
        await revokeToken(e, token, user.id, device?.device_id || 'unknown');
        await exec(e.DB, 'DELETE FROM user_devices WHERE user_id=? AND token=?', user.id, token);
      }
    }
  }
  deleteCookie(c, 'token', { path: '/' });
  return c.json({ status: 'success', msg: '已登出' });
});

// ---------------------------------------------------------------------------
// 当前会话
// ---------------------------------------------------------------------------
authRoutes.get('/session', requireAuth, async (c) => {
  const user = c.get('user');
  const e = env(c);
  return c.json({
    code: 200,
    token: c.get('token'),
    username: user.username,
    nickname: user.nickname,
    avatar: user.avatar,
    id: user.id,
    role: user.role,
    two_factor_enabled: !!user.two_factor_enabled,
    read_receipts_enabled: !!user.read_receipts_enabled,
    is_admin: isAdmin(e, user),
  });
});

// ---------------------------------------------------------------------------
// 修改密码
// ---------------------------------------------------------------------------
authRoutes.put('/user/password', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { old_password?: string; new_password?: string };

  // 与登录同样的提前拦截：超出套餐 CPU 限额的旧哈希会 500，给出可读原因
  const storedIter = iterationsOf(user.password_hash);
  const targetIter = passwordIterations(e);
  if (storedIter !== null && storedIter > targetIter) {
    return c.json(
      {
        detail:
          `账号密码哈希为 ${storedIter} 次迭代，超出当前套餐 CPU 限额无法验证。` +
          `请联系管理员重置密码，或升级到付费套餐。`,
      },
      400,
    );
  }

  const check = await verifyPassword(data.old_password || '', user.password_hash, targetIter);
  if (!check.ok) return c.json({ detail: '原密码不正确' }, 400);
  if (!data.new_password || data.new_password.length < 8) {
    return c.json({ detail: '新密码至少 8 位' }, 400);
  }

  const hashed = await hashPassword(data.new_password, targetIter);
  await exec(e.DB, 'UPDATE users SET password_hash=? WHERE id=?', hashed, user.id);
  // 换密码后所有旧会话失效
  await revokeToken(e, c.get('token'), user.id, 'password-change');
  await exec(e.DB, 'DELETE FROM user_devices WHERE user_id=?', user.id);
  return c.json({ status: 'success', msg: '密码已更新，请重新登录' });
});

// ---------------------------------------------------------------------------
// 拉黑 / 取消拉黑
// ---------------------------------------------------------------------------
authRoutes.post('/user/block', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { username?: string };
  const target = (data.username || '').trim();
  if (!target) return c.json({ detail: '缺少用户名' }, 400);

  const list = (user.blocked_users || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = list.indexOf(target);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(target);

  await exec(e.DB, 'UPDATE users SET blocked_users=? WHERE id=?', list.join(','), user.id);
  return c.json({ status: 'success', blocked: list, blocked_now: idx < 0 });
});

// ---------------------------------------------------------------------------
// 注销账号
// ---------------------------------------------------------------------------
authRoutes.delete('/user/account', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  await deleteUserAndData(e, user.id, user.username);
  deleteCookie(c, 'token', { path: '/' });
  return c.json({ status: 'success', msg: '账号已注销' });
});

// ---------------------------------------------------------------------------
// 更新个人资料
// ---------------------------------------------------------------------------
authRoutes.post('/user/profile', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { nickname?: string; avatar?: string };

  if (data.nickname !== undefined) {
    const nick = cleanText(data.nickname, 64);
    if (!nick) return c.json({ detail: '昵称不能为空' }, 400);
    await exec(e.DB, 'UPDATE users SET nickname=? WHERE id=?', nick, user.id);
  }
  if (data.avatar !== undefined) {
    await exec(e.DB, 'UPDATE users SET avatar=? WHERE id=?', data.avatar.slice(0, 512), user.id);
  }
  const fresh = await getUserByName(e.DB, user.username);
  return c.json({ status: 'success', user: publicUser(fresh as UserRow) });
});

// ---------------------------------------------------------------------------
// 用户列表
// ---------------------------------------------------------------------------
authRoutes.get('/users', requireAuth, async (c) => {
  const e = env(c);
  const rows = await qAll<UserRow>(
    e.DB,
    'SELECT id, username, nickname, avatar, role FROM users ORDER BY id DESC LIMIT 500',
  );
  return c.json(rows);
});

// ---------------------------------------------------------------------------
// 设备与安全管理
// ---------------------------------------------------------------------------
authRoutes.get('/user/devices', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    `SELECT id, device_id, device_name, user_agent, ip_address, country, last_login, last_seen
       FROM user_devices WHERE user_id=? ORDER BY last_login DESC`,
    user.id,
  );
  return c.json(rows);
});

authRoutes.post('/user/devices/register', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { device_id?: string; device_name?: string; push_token?: string };
  await registerDeviceSession(e, {
    userId: user.id,
    token: c.get('token'),
    deviceId: data.device_id,
    deviceName: data.device_name,
    userAgent: c.req.header('User-Agent') || '',
    ip: clientIp(c.req.raw),
    country: countryOf(c.req.raw),
  });
  if (data.push_token) {
    await exec(e.DB, 'UPDATE user_devices SET push_token=? WHERE user_id=? AND device_id=?',
      data.push_token.slice(0, 512), user.id, (data.device_id || '').slice(0, 128));
  }
  return c.json({ status: 'success' });
});

authRoutes.post('/user/devices/:device_id/logout', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const deviceId = c.req.param('device_id') as string;
  const row = await qOne<{ token: string | null }>(
    e.DB,
    'SELECT token FROM user_devices WHERE user_id=? AND device_id=?',
    user.id,
    deviceId,
  );
  if (row?.token) await revokeToken(e, row.token, user.id, deviceId);
  await exec(e.DB, 'DELETE FROM user_devices WHERE user_id=? AND device_id=?', user.id, deviceId);
  return c.json({ status: 'success' });
});

authRoutes.get('/user/security', requireAuth, async (c) => {
  const user = c.get('user');
  return c.json({
    two_factor_enabled: !!user.two_factor_enabled,
    read_receipts_enabled: !!user.read_receipts_enabled,
    blocked_users: (user.blocked_users || '').split(',').filter(Boolean),
  });
});

authRoutes.put('/user/security/preferences', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { read_receipts_enabled?: boolean };
  if (data.read_receipts_enabled !== undefined) {
    await exec(
      e.DB,
      'UPDATE users SET read_receipts_enabled=? WHERE id=?',
      data.read_receipts_enabled ? 1 : 0,
      user.id,
    );
  }
  return c.json({ status: 'success' });
});

authRoutes.get('/user/login-history', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    `SELECT id, device_id, device_name, ip_address, country, user_agent, success, created_at
       FROM login_history WHERE user_id=? ORDER BY id DESC LIMIT 50`,
    user.id,
  );
  return c.json(rows);
});

authRoutes.post('/user/logout-all', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const devices = await qAll<{ token: string | null; device_id: string }>(
    e.DB,
    'SELECT token, device_id FROM user_devices WHERE user_id=?',
    user.id,
  );
  for (const d of devices) {
    if (d.token) await revokeToken(e, d.token, user.id, d.device_id);
  }
  await exec(e.DB, 'DELETE FROM user_devices WHERE user_id=?', user.id);
  await revokeToken(e, c.get('token'), user.id, 'all');
  await kickUser(e, user.username);
  deleteCookie(c, 'token', { path: '/' });
  return c.json({ status: 'success', msg: '已退出全部设备' });
});

authRoutes.post('/user/push_token', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { push_token?: string; device_id?: string };
  await exec(e.DB, 'UPDATE users SET push_token=? WHERE id=?', (data.push_token || '').slice(0, 512), user.id);
  if (data.device_id) {
    await exec(
      e.DB,
      'UPDATE user_devices SET push_token=? WHERE user_id=? AND device_id=?',
      (data.push_token || '').slice(0, 512),
      user.id,
      data.device_id.slice(0, 128),
    );
  }
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 两步验证（TOTP）
// ---------------------------------------------------------------------------
authRoutes.post('/user/two-factor/setup', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const secret = generateTotpSecret();
  await exec(e.DB, 'UPDATE users SET two_factor_secret=? WHERE id=?', secret, user.id);
  const otpauth = `otpauth://totp/OpenBoard:${encodeURIComponent(user.username)}?secret=${secret}&issuer=OpenBoard`;
  return c.json({ secret, otpauth });
});

authRoutes.post('/user/two-factor/confirm', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { code?: string };
  const secret = user.two_factor_secret || (
    await qOne<{ two_factor_secret: string }>(e.DB, 'SELECT two_factor_secret FROM users WHERE id=?', user.id)
  )?.two_factor_secret;
  if (!secret) return c.json({ detail: '请先获取密钥' }, 400);

  const ok = await verifyTotp(secret, data.code || '');
  if (!ok) return c.json({ detail: '动态码不正确' }, 400);

  await exec(e.DB, 'UPDATE users SET two_factor_enabled=1 WHERE id=?', user.id);
  return c.json({ status: 'success', two_factor_enabled: true });
});

authRoutes.post('/user/two-factor/disable', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { code?: string; password?: string };
  if (user.two_factor_enabled === 1) {
    const ok = await verifyTotp(user.two_factor_secret || '', data.code || '');
    if (!ok) return c.json({ detail: '动态码不正确' }, 400);
  }
  await exec(e.DB, 'UPDATE users SET two_factor_enabled=0, two_factor_secret=NULL WHERE id=?', user.id);
  return c.json({ status: 'success', two_factor_enabled: false });
});

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------
authRoutes.get('/qr/generate', async (c) => {
  const e = env(c);
  const qrId = randomId(16);
  await exec(e.DB, 'INSERT INTO qr_sessions (qr_id, status) VALUES (?, ?)', qrId, 'pending');
  return c.json({ qr_id: qrId, expires_in: 300 });
});

authRoutes.get('/qr/status', async (c) => {
  const e = env(c);
  const qrId = c.req.query('qr_id') || '';
  const row = await qOne<{ status: string; token: string | null }>(
    e.DB,
    'SELECT status, token FROM qr_sessions WHERE qr_id=?',
    qrId,
  );
  if (!row) return c.json({ detail: '二维码不存在或已过期' }, 404);
  if (row.status === 'authorized' && row.token) {
    setSessionCookie(c, row.token, true);
    await exec(e.DB, 'DELETE FROM qr_sessions WHERE qr_id=?', qrId);
    return c.json({ status: 'authorized', token: row.token });
  }
  return c.json({ status: row.status });
});

authRoutes.post('/qr/scan', requireAuth, async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as { qr_id?: string };
  const qrId = (data.qr_id || '').trim();
  const row = await qOne<{ status: string }>(e.DB, 'SELECT status FROM qr_sessions WHERE qr_id=?', qrId);
  if (!row) return c.json({ detail: '二维码不存在或已过期' }, 404);
  await exec(e.DB, "UPDATE qr_sessions SET status='scanned' WHERE qr_id=?", qrId);
  return c.json({ status: 'scanned', username: c.get('user').username });
});

authRoutes.post('/qr/authorize', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { qr_id?: string };
  const qrId = (data.qr_id || '').trim();
  const row = await qOne<{ status: string }>(e.DB, 'SELECT status FROM qr_sessions WHERE qr_id=?', qrId);
  if (!row) return c.json({ detail: '二维码不存在或已过期' }, 404);

  const token = await createSessionToken(
    e,
    { id: user.id, username: user.username, role: user.role },
    true,
  );
  await exec(e.DB, "UPDATE qr_sessions SET status='authorized', token=? WHERE qr_id=?", token, qrId);
  return c.json({ status: 'authorized' });
});

// ---------------------------------------------------------------------------
// 管理员：重置他人密码
// ---------------------------------------------------------------------------
authRoutes.post('/admin/reset-password', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as {
    username?: string;
    user_id?: number | string;
    new_password?: string;
  };
  let target = (data.username || '').trim();
  if (!target && data.user_id) {
    const row = await qOne<{ username: string }>(
      e.DB,
      'SELECT username FROM users WHERE id=?',
      Number(data.user_id),
    );
    target = row?.username || '';
  }
  if (!target || !data.new_password || data.new_password.length < 8) {
    return c.json({ detail: '参数不完整' }, 400);
  }
  const hashed = await hashPassword(data.new_password, passwordIterations(e));
  await exec(e.DB, 'UPDATE users SET password_hash=? WHERE username=?', hashed, target);
  return c.json({ status: 'success', msg: `已重置 ${target} 的密码` });
});
