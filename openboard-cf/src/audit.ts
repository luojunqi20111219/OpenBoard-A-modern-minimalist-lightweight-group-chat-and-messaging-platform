/**
 * 管理端审计日志 —— 公共模块。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独抽出来
 * ---------------------------------------------------------------------------
 * 原本 `routes/admin.ts` 与 `routes/admin-grants.ts` 各写了一份 audit()，
 * 逻辑相同但签名不同（前者 actor 可空、后者必填）。两份实现漂移的风险是
 * 真实存在的：只要有一边改了字段名或表名，另一边的日志就会静默丢失，
 * 而审计日志丢一条**当时是看不出来的**，等要追溯时才发现断层。
 *
 * 这里统一成一份。签名取宽松版（actor 可空），因为调用方常常是
 * `c.get('user')?.username` 这种可能为空的取值；actor 为空时直接跳过，
 * 由调用方保证在需要留痕的路径上传入真实操作者。
 *
 * ---------------------------------------------------------------------------
 * 失败语义
 * ---------------------------------------------------------------------------
 * 审计是附属能力，不该拖垮操作本身 —— 表还没迁移时 INSERT 会抛错，
 * 这里吞掉。代价是「未迁移环境没有审计」，这是刻意接受的：
 * 迁移前本来也没有审计表可写。
 */
import type { Env } from './auth';
import { exec, nowIso } from './db';

/** 写管理端审计日志。失败不阻断主流程（审计表可能尚未迁移） */
export async function audit(
  e: Env,
  actor: string | undefined,
  action: string,
  target: string | null,
  detail?: string,
): Promise<void> {
  if (!actor) return;
  try {
    await exec(
      e.DB,
      'INSERT INTO admin_audit_logs (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      actor,
      action,
      target,
      detail ?? null,
      nowIso(),
    );
  } catch {
    /* 表未迁移，忽略 */
  }
}

/**
 * 批量操作写汇总日志时，detail 里最多列这么多个 id。
 *
 * 一次删 500 条消息若逐条写日志会瞬间把审计表刷满，反而淹没真正
 * 需要关注的提权类操作；写一条汇总 + 前若干个 id 已经够定位问题。
 */
export const AUDIT_ID_PREVIEW = 20;

/** 把一组 id 压成「共 N 条：1,2,3…」形式的 detail */
export function summarizeIds(ids: Array<string | number>, label = '共'): string {
  const shown = ids.slice(0, AUDIT_ID_PREVIEW).join(',');
  const tail = ids.length > AUDIT_ID_PREVIEW ? '…' : '';
  return `${label} ${ids.length} 条：${shown}${tail}`;
}
