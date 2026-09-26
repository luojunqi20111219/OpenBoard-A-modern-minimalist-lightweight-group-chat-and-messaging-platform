/**
 * Cloudflare 绑定与环境变量
 */
export interface Env {
  /** D1 数据库（原 SQLite board.db）—— 强一致，存所有业务数据 */
  DB: D1Database;
  /** R2 存储桶（原本地 uploads/ 目录）—— 文件与头像 */
  UPLOADS: R2Bucket;
  /**
   * KV —— 只存"容忍短暂陈旧"的数据：
   *   · 登录限流计数（写多读多，但偶尔漏计一次无伤大雅）
   *   · 在线用户快照（DO 是权威源，KV 只是给非关键路径读的缓存）
   *
   * ⚠️ 不要把用户账号、会话、封禁状态放进 KV。
   * KV 是最终一致，写入后全球生效需要数十秒，
   * 会导致「改完密码旧密码还能登录」「封禁后仍可发消息」这类安全问题。
   */
  RATE_LIMIT?: KVNamespace;
  /** Durable Object 命名空间 —— WebSocket 广播中枢 */
  CHAT_HUB: DurableObjectNamespace;
  /** JWT 签名密钥，生产环境用 `wrangler pages secret put JWT_SECRET` 设置 */
  JWT_SECRET?: string;
  CURRENT_VERSION?: string;
  /** 逗号分隔的管理员用户名 */
  ALLOWED_ADMINS?: string;
  MAX_CONNECTIONS_PER_USER?: string;
  /** 是否允许免鉴权读取 R2 中的上传文件（图片直链），默认 true */
  PUBLIC_UPLOADS?: string;
}

/** 默认 JWT 密钥（仅本地开发；生产环境未设置会打警告日志） */
export const DEV_FALLBACK_SECRET = 'openboard-dev-secret-do-not-use-in-production';

export function jwtSecret(env: Env): string {
  return (env.JWT_SECRET && env.JWT_SECRET.length > 0) ? env.JWT_SECRET : DEV_FALLBACK_SECRET;
}

export function adminList(env: Env): string[] {
  return (env.ALLOWED_ADMINS || '官方账号,Forest_siri,Forest_Brian_Birch')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function maxConnectionsPerUser(env: Env): number {
  const n = parseInt(env.MAX_CONNECTIONS_PER_USER || '4', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/** 上传目录公开读取开关，默认开启（图片需要能被 <img> 直接加载） */
export function publicUploads(env: Env): boolean {
  return (env.PUBLIC_UPLOADS || 'true').toLowerCase() !== 'false';
}
