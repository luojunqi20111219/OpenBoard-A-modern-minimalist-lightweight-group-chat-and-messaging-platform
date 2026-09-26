/**
 * 文本清洗 —— 替代原项目的 bleach
 * 原实现 bleach.clean(text, tags=[], strip=True)：去掉全部 HTML 标签，保留纯文本
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** 等价于 bleach.clean(text, tags=[], strip=True)，可选按字符数截断 */
export function cleanText(text: string, max?: number): string {
  if (!text) return '';
  // 1. 移除所有标签（含注释、脚本块）
  let out = text.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<\/?[^>]*>/g, '');
  // 2. 转义残留的特殊字符
  const cleaned = escapeHtml(out).trim();
  return max && cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** 用户名：仅允许字母数字下划线和中文，长度 2-32 */
export function isValidUsername(name: string): boolean {
  return /^[\w\u4e00-\u9fa5.-]{2,32}$/.test(name);
}

/** 裁剪超长消息，避免撑爆 D1 单行与广播包 */
export function clampText(text: string, max = 8000): string {
  return text.length > max ? text.slice(0, max) : text;
}
