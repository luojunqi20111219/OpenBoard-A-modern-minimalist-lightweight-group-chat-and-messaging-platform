/**
 * 认证相关路由 —— 迁移自 app/routes/auth.py
 * 响应结构与 Python 版保持一致，现有客户端无需改动即可对接。
 */
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { HonoEnv, Env } from '../auth';
import {
  requireAuth,
  requireAdmin,
  createAccessToken,
  revokeToken,
  isAdmin,
  isAdminAsync,
} from '../auth';
import { qAll, qOne, exec, getUserByName, publicUser, UserRow, nowIso, utcOut } from '../db';
import {
  hashPassword,
  verifyPassword,
  isUnsupportedHash,
  iterationsOf,
  needsPasswordReset,
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
import { kvClaimDailyOnce, kvBumpDailyCount } from '../kv';
import { cleanText, isValidUsername } from '../sanitize';
import { kickUser } from '../realtime';

export const authRoutes = new Hono<HonoEnv>();

const REMEMBER_SESSION_MINUTES = 60 * 24 * 30;
const BROWSER_SESSION_MINUTES = 60 * 12;

/**
 * 自助重置用的默认密码。
 *
 * ⚠️ 这是一个**公开的弱密码**，它存在的唯一意义是「临时的、一次性的钥匙」——
 *    让因为旧格式哈希而彻底登不上的用户能进来一次，然后**立刻改掉**。
 *    所以它必须同时满足两点，缺一不可：
 *      1. 重置后打 must_change_password 标记，客户端强制弹改密页
 *      2. 改密码接口拒绝把新密码设成这个值（见 /user/password）
 *    只做 1 不做 2，用户可以直接"改成"同一个密码，闭环就断了。
 */
const DEFAULT_PASSWORD = '12345678';

/** 自助重置的频率上限 */
const RESET_DAILY_PER_ACCOUNT = 1; // 每账号每天
const RESET_DAILY_PER_IP = 10; // 每 IP 每天
const RESET_WINDOW_SECONDS = 24 * 60 * 60;

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
// 服务器能力探测
//
// ---------------------------------------------------------------------------
// 为什么需要它
// ---------------------------------------------------------------------------
// 客户端要知道"对面这台服务器支不支持自助重置密码"，才能决定登录页上
// 要不要显示那个按钮。
//
// 光靠"400 响应里有没有 self_service"不够：老版本服务端（v10.0.0 及更早）
// 的 400 响应带 admin_contact 但**不带** self_service；而普通 FastAPI 版
// 服务端连 admin_contact 都没有。这两种情况下客户端如果按"没说不支持就是
// 支持"来推断，就会显示一个点了必然失败的按钮 —— 用户点下去拿到 404 或
// 一坨 HTML，完全不知道发生了什么。
//
// 所以改成**由服务端显式声明能力**，客户端按"默认不支持"处理。
//
// ---------------------------------------------------------------------------
// 安全
// ---------------------------------------------------------------------------
//   · 无需鉴权 —— 它在登录前就要用到，而且只暴露"有哪些功能"，
//     不含版本号以外的任何环境信息（不暴露 D1 ID / KV ID / 密钥）
//   · 版本号本身是公开的（更新检查接口早就在返回）
// ---------------------------------------------------------------------------
authRoutes.get('/capabilities', (c) => {
  const e = env(c);
  return c.json({
    // 客户端据此区分部署形态：cloudflare-workers / fastapi / unknown
    server: 'cloudflare-workers',
    version: e.CURRENT_VERSION || 'unknown',
    // 能力清单：客户端**只认显式为 true 的项**，缺省一律按不支持
    features: {
      self_reset_password: true,
      must_change_password: true,
      admin_grants: true,
      // 旧格式（scrypt / 高迭代 pbkdf2）哈希在本部署上无法校验，
      // 这正是"需要重置密码"这个状态的来源
      legacy_hash_unsupported: true,
    },
  });
});

// ---------------------------------------------------------------------------
// 自助重置为默认密码
//
// ---------------------------------------------------------------------------
// 为什么需要这个接口
// ---------------------------------------------------------------------------
// 旧库里 werkzeug 默认的 scrypt:32768:8:1 哈希，验证一次约 75ms CPU，
// 而 Cloudflare Free 计划每请求上限 10ms —— 物理上算不完。
// 这些账号的密码**任何人**都登录不了（服务器算不动校验），
// 原来的做法是「请联系管理员」，但管理员是谁、怎么联系，客户端给不出答案，
// 用户就卡死在这里了。
//
// 所以改成：让用户自己把这个废账号的密码重置成默认密码，
// 登进去之后再强制改密。
//
// ---------------------------------------------------------------------------
// 安全边界（三条，缺一不可）
// ---------------------------------------------------------------------------
//   1. 只能重置「当前就登不上」的账号 —— needsPasswordReset() 为真。
//      这类账号本来无人可登录，重置它不构成窃取。
//      密码正常的账号走这条路会被 400 拒掉，攻击者拿不到任何东西。
//   2. 不能重置管理员（三层判定）与系统账号（role=2）。
//      否则任何人把管理员密码设成 12345678 就能进管理端。
//   3. 限流：每账号每天 1 次、每 IP 每天 10 次。
//
// ⚠️ 边界 1/2 是**真正的安全底线**，必须走 D1 判定，不能依赖 KV。
//    边界 3 属于防骚扰，KV 未绑定时降级放行 —— 丢的是频率限制，不是安全。
// ---------------------------------------------------------------------------
authRoutes.post('/reset-to-default', async (c) => {
  const e = env(c);
  const data = (await c.req.json().catch(() => ({}))) as { username?: string };
  const username = (data.username || '').trim();
  const ip = clientIp(c.req.raw);

  if (!username) return c.json({ detail: '缺少用户名' }, 400);

  // ---- 边界 3：按 IP 限流（先查，避免无脑刷） ----
  const ipKey = `reset:default:ip:${ip}`;
  const ipCount = await kvBumpDailyCount(e, ipKey, RESET_WINDOW_SECONDS);
  if (ipCount > RESET_DAILY_PER_IP) {
    return c.json({ detail: '操作过于频繁，请明天再试' }, 429);
  }

  const user = await getUserByName(e.DB, username);
  if (!user) return c.json({ detail: '用户不存在' }, 404);

  // ---- 系统账号：永远是拒绝的第一优先级 ----
  if (user.role === 2) {
    return c.json({ detail: '系统账号不允许重置密码' }, 403);
  }

  if (user.is_banned === 1) {
    return c.json({ detail: '您的账号已被封禁，请联系管理员' }, 403);
  }

  // ---- 边界 2：管理员拦截 ----
  // 必须放在 needsPasswordReset 之前：管理员即使密码是旧格式也不能自助重置，
  // 否则「枚举管理员用户名 → 重置成 12345678 → 登进管理端」就是一条完整的提权链。
  if (await isAdminAsync(e, user)) {
    return c.json(
      { detail: '管理员账号不能自助重置密码，请联系其他管理员在管理端处理' },
      403,
    );
  }

  // ---- 边界 3：按账号限流（每天 1 次） ----
  //
  // ⚠️ 必须放在 needsPasswordReset 检查**之前**。
  //    顺序反了的话，第一次重置成功后密码已变成 pbkdf2，"需要重置"不再成立，
  //    第二次请求会走到「该账号可以正常登录，无需重置」这条 400 分支 ——
  //    用户看到的是"无需重置"，而实际上他今天已经重置过了、且可能没记住
  //    或者没拿到那次的密码。真正该说的是「今天重置过了，用 12345678 登录去」，
  //    那条提示在 429 里。
  //
  // key 用**库里存的那个用户名**（user.username）而不是请求里的原始输入：
  //    用户名查询是大小写敏感的精确匹配，但限流 key 如果也用原始输入，
  //    大小写不同的请求会被算成不同的账号，等于限流可以被轻松绕过。
  //    用库里的规范值归一化，同一账号不管怎么混大小写都共用一个计数器。
  const accountKey = `reset:default:u:${user.username.toLowerCase()}`;
  const firstToday = await kvClaimDailyOnce(e, accountKey);
  if (!firstToday) {
    return c.json(
      {
        detail:
          `该账号今天已经重置过密码了。请直接用默认密码 ${DEFAULT_PASSWORD} 登录；` +
          '如果仍然登录不上，请联系管理员。',
      },
      429,
    );
  }

  // ---- 边界 1：只有"本来就算不动"的账号能被重置 ----
  const needsReset = needsPasswordReset(user.password_hash, passwordIterations(e));
  if (!needsReset) {
    return c.json(
      {
        detail:
          '该账号的密码可以正常登录，无需重置。' +
          '如果您忘记了密码，请联系管理员在「管理端」为您重置。',
      },
      400,
    );
  }

  // ---- 真正执行重置 ----
  const iter = passwordIterations(e);
  const hash = await hashPassword(DEFAULT_PASSWORD, iter);

  // 记下旧算法，便于事后追溯"这个账号是从什么状态被救活的"
  const oldAlgo = (user.password_hash || '').split('$')[0] || '';

  // ⚠️ must_change_password 是迁移后加的列，**未跑迁移的部署上不存在**。
  //
  // 直接写会抛 D1_ERROR: no such column —— 请求变成 500，而用户看到的
  // 只有「服务器内部错误」，完全不知道发生了什么。而"没跑迁移"在部署流程里
  // 是很正常的一个中间状态（`d1:init` 之后、点「应用迁移」之前）。
  //
  // 策略：先试带标记的写法，失败就退回不带标记的写法。
  // 退回时**功能仍然可用**（密码确实被重置了），只是少了"登录后强制改密"
  // 这一层 —— 所以把这件事记进来，让调用方知道降级了。
  let flagPersisted = true;
  try {
    await exec(
      e.DB,
      'UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?',
      hash,
      user.id,
    );
  } catch {
    flagPersisted = false;
    await exec(e.DB, 'UPDATE users SET password_hash=? WHERE id=?', hash, user.id);
  }

  // 重置后强制下线：旧会话（如果有人持有）不能继续用
  await kickUser(e, username);

  // 审计留痕。表可能还没迁移，失败不阻断。
  // actor 用 'self-service' 而不是用户名 —— 让管理员事后能一眼区分
  // 「用户自己重置的」和「我替他重置的」。
  try {
    await exec(
      e.DB,
      'INSERT INTO admin_audit_logs (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      'self-service',
      'user.reset_to_default',
      username,
      `旧算法：${oldAlgo || '未知'}${flagPersisted ? '' : '；未迁移，未能写入强制改密标记'}`,
      nowIso(),
    );
  } catch {
    /* admin_audit_logs 未迁移，忽略 */
  }

  return c.json({
    status: 'success',
    username,
    default_password: DEFAULT_PASSWORD,
    // 未迁移时是 false —— 客户端据此不再期待"登录后会被强制改密"，
    // 但仍应在界面上提醒用户尽快自行修改密码。
    must_change_password: flagPersisted,
    migration_required: !flagPersisted,
    algorithm: `pbkdf2:sha256:${iter}`,
    msg: flagPersisted
      ? `密码已重置为默认密码 ${DEFAULT_PASSWORD}，请用它登录并立即修改新密码`
      : `密码已重置为默认密码 ${DEFAULT_PASSWORD}，请用它登录并立即修改新密码` +
        '（服务端尚未完成迁移，建议管理员尽快执行迁移）',
    // 客户端据此直接填充输入框
    login_hint: { username, password: DEFAULT_PASSWORD },
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

  // ---------------------------------------------------------------------
  // 旧格式哈希（scrypt / 高迭代 pbkdf2）→ 引导用户联系管理员
  //
  // 这不是「密码错了」，而是**当前套餐根本算不动这个哈希**：
  //   werkzeug 3.x 默认 scrypt:32768:8:1，验证一次约 75ms CPU
  //   Cloudflare 免费版每请求上限 10ms → 物理上跑不完
  //
  // 所以不能笼统说「密码错误」（会让用户反复试、白白触发锁定），
  // 而要明确告诉他们：密码没输错，是账号需要重置 —— 并给出联系通道。
  // ---------------------------------------------------------------------
  const phAlgo = (user.password_hash || '').split('$')[0] || '';
  const storedIter = iterationsOf(user.password_hash);
  const targetIter = passwordIterations(e);

  const needReset = isUnsupportedHash(user.password_hash)
    || (storedIter !== null && storedIter > targetIter);

  if (needReset) {
    const reason = isUnsupportedHash(user.password_hash)
      ? (phAlgo.startsWith('scrypt')
          ? '该账号使用旧版 scrypt 加密（werkzeug 默认参数），当前部署环境无法完成校验'
          : `该账号使用旧版加密格式（${phAlgo || '未知'}），当前部署环境无法完成校验`)
      : `该账号密码哈希迭代 ${storedIter} 次，超出当前运行套餐的 CPU 限额（${targetIter}）`;

    return c.json(
      {
        detail: '该账号需要重置密码后才能登录',
        code: 'PASSWORD_RESET_REQUIRED',
        reason,
        // 联系管理员的通道 —— 客户端与网页都据此渲染
        admin_contact: {
          // 管理端客户端名称与入口，前端可直接展示
          title: '该账号需要重置密码',
          message:
            '您的密码本身没有输错，只是该账号用的是旧版加密方式，' +
            '当前服务器无法自动校验。' +
            `您可以点下方按钮把密码重置为默认密码 ${DEFAULT_PASSWORD}，` +
            '登录后请立即修改成自己的新密码。',
          // 页面直接跳转的联系入口
          action_url: '/contact-admin',
          action_label: '查看联系方式',
          // ---- 自助重置通道 ----
          // self_service 为 true 表示「这个 400 用户自己能解决」，
          // 客户端据此把主按钮切成「重置为默认密码」，
          // 而不是只显示一个找不到人的联系方式。
          self_service: true,
          default_password: DEFAULT_PASSWORD,
          // 管理员用户名列表 —— 让 App 不必跳浏览器就能把名字显示出来，
          // 用户可以直接复制去发给对方。
          //
          // 这里只放**用户名**：它本来就在 /contact-admin 页面上明文展示，
          // 也存在 ALLOWED_ADMINS 里，不构成新增信息泄露。
          // ⚠️ 不要往这里加邮箱 / 手机号 / 任何隐私字段。
          admins: adminList(e),
        },
        unavailable_since: phAlgo || null,
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
    // 用默认密码登录 → 客户端必须先弹改密页，改完才让进主界面。
    // 列可能不存在（未迁移），用 !! 归一化，缺列时按 false 处理。
    must_change_password: !!user.must_change_password,
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
  // 不允许把密码"改"成默认密码 —— 否则强制改密的闭环就断了：
  // 用户大可以从 12345678 直接改成 12345678，永远停在这个弱密码上。
  // 长度校验放在前面，所以这里只需比对值本身。
  if (data.new_password === DEFAULT_PASSWORD) {
    return c.json(
      { detail: `新密码不能使用默认密码 ${DEFAULT_PASSWORD}，请换一个` },
      400,
    );
  }

  const hashed = await hashPassword(data.new_password, targetIter);
  // 顺带清掉 must_change_password：用户已经改过密码了，
  // 再带着这个标记的话，下次登录又会被弹一次改密页。
  //
  // ⚠️ 该列是迁移后加的，未迁移的部署上不存在 —— 带上它会抛
  //    D1_ERROR: no such column，把"改密码"这个基础功能变成 500。
  //    未迁移时退回不带标记的写法：改密码依然成功（这才是主线），
  //    只是那个可能不存在的标记没被清掉而已。
  try {
    await exec(
      e.DB,
      'UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?',
      hashed,
      user.id,
    );
  } catch {
    await exec(e.DB, 'UPDATE users SET password_hash=? WHERE id=?', hashed, user.id);
  }
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
  const rows = await qAll<{ last_login?: string | null; last_seen?: string | null }>(
    e.DB,
    `SELECT id, device_id, device_name, user_agent, ip_address, country, last_login, last_seen
       FROM user_devices WHERE user_id=? ORDER BY last_login DESC`,
    user.id,
  );
  return c.json(
    rows.map((r) => ({
      ...r,
      last_login: utcOut(r.last_login),
      last_seen: utcOut(r.last_seen),
    })),
  );
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
  const rows = await qAll<{ created_at?: string }>(
    e.DB,
    `SELECT id, device_id, device_name, ip_address, country, user_agent, success, created_at
       FROM login_history WHERE user_id=? ORDER BY id DESC LIMIT 50`,
    user.id,
  );
  return c.json(rows.map((r) => ({ ...r, created_at: utcOut(r.created_at) })));
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
// 注意：这里原本还有一个 `POST /admin/reset-password`（连字符），
// 与 routes/admin.ts 的 `/admin/reset_password`（下划线）功能重复，
// 且缺少 audit、强度校验、role=2 保护、自锁保护和 kickUser —— 已删除。
//
// 为什么删这个而不是那个：admin.ts 那份是管理端 App 唯一在用的入口
// （AdminApiService 里写的是下划线版本），校验也完整。留一个更弱的
// 同名接口只会给未来埋雷：某天有人照文档调连字符版，绕过所有保护。
// ---------------------------------------------------------------------------

