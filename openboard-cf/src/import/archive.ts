/**
 * 归档包解析 —— 从「旧项目根目录的压缩包 / 文件夹」里切出 board.db 与附件。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个模块
 * ---------------------------------------------------------------------------
 * 旧版（Python/FastAPI）把所有上传的附件放在项目根目录的 `uploads/` 下，
 * 文件名形如 `{uuid4hex}.{ext}`，图片还有 `{uuid4hex}.thumb.jpg` 缩略图。
 * 消息正文里存的是这些**路径**：
 *     [img:/uploads/ab12….jpg|/uploads/ef34….thumb.jpg]
 *     [file:/api/download/ab12….jpg?name=photo.jpg|photo.jpg]
 *
 * 所以迁移附件时有一个硬性约束：
 *     **R2 里的 key 必须与旧文件名逐字节相同**，否则历史消息里的链接
 *     全部失效（前端 safeLocalUrl 会判成非法 URL 直接渲染成「无效图片」）。
 *
 * ---------------------------------------------------------------------------
 * 支持的输入形态
 * ---------------------------------------------------------------------------
 *   1. zip          —— 最常见（右键 → 压缩）
 *   2. tar / tar.gz / tgz / gz —— Linux / macOS 的 `tar czf`
 *   3. 文件夹 / 多文件 —— 前端用 <input webkitdirectory> 或多次选择拿到
 *      FileList，本模块直接按 `relativePath` 归一，不需要压缩
 *
 * 三种形态最终都归约成同一份 `ArchiveNode[]`（路径 + 字节），
 * 后续定位 board.db / 收集附件 的逻辑与格式无关。
 *
 * ---------------------------------------------------------------------------
 * 安全守卫
 * ---------------------------------------------------------------------------
 * 解压炸弹是真实威胁（一个 42KB 的 zip 能膨胀到 4PB）。
 * 这里设三道闸：条目数、单条目、解压总量，外加一个**膨胀比**检查。
 * 超限直接抛错，不浪费内存。
 */
import { unzipSync, gunzipSync, decompressSync } from 'fflate';

/** 归档包上传体积上限。Free 计划请求体硬上限 100MB，这里留足余量。 */
export const MAX_ARCHIVE_BYTES = 60 * 1024 * 1024;

/** 解压后总字节上限 —— 防止 zip bomb（Free 计划单请求内存 128MB） */
export const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;

/** 单个文件解压上限 */
const MAX_SINGLE_FILE_BYTES = 80 * 1024 * 1024;

/** 归档内条目数上限 */
const MAX_ENTRIES = 20_000;

/** 附件数量上限（写入 R2 的次数，太多会让单请求超时） */
const MAX_ATTACHMENTS = 5_000;

/** 压缩比警戒线：解压后 / 压缩前 > 此值且总量 > 8MB 时视为可疑 */
const MAX_RATIO = 200;

/** 数据库文件名（大小写不敏感） */
const DB_BASENAMES = new Set(['board.db', 'board.sqlite', 'board.sqlite3', 'app.db', 'data.db']);

/** 附件名形如 `{32位hex}.{ext}` 或 `{32位hex}.thumb.jpg` */
const ATTACHMENT_RE = /^[0-9a-f]{32}\.(?:thumb\.)?[a-z0-9]{1,10}$/i;

/** 附件扩展名 → MIME（R2 直链要靠它让浏览器正确渲染） */
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  zip: 'application/zip',
  apk: 'application/vnd.android.package-archive',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'video/webm',
};

export function mimeOf(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// 归一化后的节点
// ---------------------------------------------------------------------------
export interface ArchiveNode {
  /** 归档内的相对路径（已去掉包裹目录、已处理分隔符） */
  path: string;
  /** 文件名（path 的最后一段） */
  name: string;
  bytes: Uint8Array;
}

export interface AttachmentEntry {
  /** R2 key —— 与旧版 uploads/ 下的文件名逐字节相同 */
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ArchiveParseResult {
  /** 归档/文件夹是否成功解出（哪怕没有 db 也返回，便于给出精准提示） */
  nodes: ArchiveNode[];
  /** 找到的 board.db 字节（递归搜索，排除 uploads/ 与 node_modules/） */
  dbBytes: Uint8Array | null;
  /** 找到 db 时它在归档里的位置，用于展示 */
  dbPath: string | null;
  /** 待写入 R2 的附件 */
  attachments: AttachmentEntry[];
  /** 归档格式：zip / tar / tar.gz / gzip / files */
  format: string;
  /** 解压后总字节 */
  unpackedBytes: number;
  /** 被跳过的可疑/超大条目数 */
  skipped: number;
}

export class ArchiveError extends Error {}

// ---------------------------------------------------------------------------
// 输入形态 1/2：单个压缩文件
// ---------------------------------------------------------------------------
/** 按魔数与扩展名判断归档格式 */
export function detectArchiveFormat(filename: string, bytes: Uint8Array): string | null {
  const lower = (filename || '').toLowerCase();
  const magic4 = bytes.length >= 4 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : '';
  const magic2 = bytes.length >= 2 ? (bytes[0] << 8) | bytes[1] : 0;

  if (magic4 === 'PK\x03\x04' || magic4 === 'PK\x05\x06' || magic4 === 'PK\x07\x08') return 'zip';
  if (magic2 === 0x1f8b) return lower.endsWith('.tar.gz') || lower.endsWith('.tgz') ? 'tar.gz' : 'gzip';

  // tar：offset 257 处是 "ustar"
  if (bytes.length > 262) {
    const ustar = String.fromCharCode(bytes[257], bytes[258], bytes[259], bytes[260], bytes[261]);
    if (ustar === 'ustar') return 'tar';
  }
  // 魔数没对上时退回扩展名（有些 tar 由 Windows 工具生成，缺 ustar 标记）
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

/** 解 zip。返回 `路径 → 字节` 的扁平表。 */
function unpackZip(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const files = unzipSync(buf, {
    filter(file) {
      // 目录条目的 size 为 0，跳过能省不少事
      if (file.name.endsWith('/')) return false;
      if (file.originalSize > MAX_SINGLE_FILE_BYTES) {
        throw new ArchiveError(
          `归档内单个文件过大（${(file.originalSize / 1024 / 1024).toFixed(1)}MB）：${file.name}`,
        );
      }
      return true;
    },
  });
  for (const [name, bytes] of Object.entries(files)) out.set(name, bytes);
  return out;
}

// ---------------------------------------------------------------------------
// tar 解析器 —— 手写，因为 fflate 不提供 tar
// ---------------------------------------------------------------------------
//
// tar 的格式非常简单：每 512 字节一个 header block，
// 紧跟着数据（补齐到 512 的整数倍），遇到两个全零 block 结束。
//
// 这里只处理两种条目类型：
//   '0' / '\0' —— 普通文件
//   '5'        —— 目录（跳过）
// 其余（硬链接、设备节点、PAX 扩展头等）一律跳过 —— 迁移场景用不到。
function untar(buf: Uint8Array, maxBytes: number): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder('utf-8');
  let offset = 0;
  let total = 0;
  let zeroBlocks = 0;

  // 读一个以 NUL 结尾的字段
  const readStr = (start: number, len: number) =>
    decoder.decode(buf.subarray(start, start + len)).replace(/\0.*$/, '').trim();

  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);

    // 全零 block：连续两个表示归档结束
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      zeroBlocks++;
      offset += 512;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;

    const name = readStr(offset, 100);
    const sizeStr = readStr(offset + 124, 12);
    const typeFlag = String.fromCharCode(buf[offset + 156] || 0);
    // size 字段是八进制；非法就当作 0
    const size = sizeStr ? parseInt(sizeStr, 8) || 0 : 0;

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    // GNU 长文件名扩展头（类型 'L'）：下一块的 header 是真正的文件名
    // 这里不展开支持 —— 直接跳过数据，名字会退化成截断的 100 字节版本，
    // 对 `uploads/{32hex}.{ext}` 这种短路径完全够用。
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      if (name && size >= 0 && dataEnd <= buf.length) {
        if (size > MAX_SINGLE_FILE_BYTES) {
          throw new ArchiveError(`归档内单个文件过大（${(size / 1024 / 1024).toFixed(1)}MB）：${name}`);
        }
        total += size;
        if (total > maxBytes) {
          throw new ArchiveError(`解压后总大小超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`);
        }
        // 复制一份，避免把整个原始 buffer 钉在内存里
        out.set(name, buf.slice(dataStart, dataEnd));
      }
    }

    // 前进到下一个 header（数据区补齐到 512 整数倍）
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return out;
}

// ---------------------------------------------------------------------------
// 路径归一
// ---------------------------------------------------------------------------
/**
 * 把归档里的原始路径整理成可直接用的相对路径：
 *   · 反斜杠 → 正斜杠（Windows 压缩工具会写 `uploads\a.jpg`）
 *   · 去掉开头的 `./`
 *   · 丢掉路径穿越段（`..`）与绝对路径前缀
 *   · 中文等非 ASCII 文件名若被当作 latin1 解出来会成乱码，
 *     这里尝试用 UTF-8 重新解码修正
 */
function normalizePath(raw: string): string | null {
  let p = raw.replace(/\\/g, '/');
  // macOS 归档常见的 `__MACOSX/` 与 `.DS_Store` —— 直接丢
  if (p.includes('__MACOSX/') || p.endsWith('.DS_Store') || p.endsWith('/.DS_Store')) return null;

  p = p.replace(/^\.\//, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null; // 穿越，整条丢掉
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  p = parts.join('/');
  if (p.length > 500) return null;
  return p;
}

/**
 * 修正文件名编码。
 *
 * zip 规范里文件名是 CP437/UTF-8 二选一，用 bit 11 标记。不少 Windows
 * 压缩工具标记成 UTF-8 却按 GBK 写入，中文名会变成乱码；中文在
 * `uploads/` 里只会出现在缩略图后缀等位置，影响面小但值得修。
 * 这里只在「解出来全是 C1 控制区字符」时尝试重编码，避免误伤。
 */
function fixMojibake(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  if (!/^[\u0080-\u00ff]*$/.test(name)) return name;
  try {
    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i) & 0xff;
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return decoded;
  } catch {
    return name;
  }
}

/**
 * 去掉「根目录包裹」。
 *
 * 用户在 Windows 上右键压缩 `openboard` 文件夹会得到 `openboard/board.db`；
 * 在 Finder 里压缩会得到 `openboard 2/board.db`。这层包裹会让
 * 「在归档里找 board.db」变成玄学。
 *
 * 做法：找到第一个含 `board.db`（不限大小写）或 `uploads/` 的目录，
 * 把该目录作为新的根；找不到就原样返回。
 */
function stripWrapper(nodes: ArchiveNode[]): ArchiveNode[] {
  // 按第一段目录名分组，取「最浅」的候选根
  const candidates = new Map<string, number>();
  for (const n of nodes) {
    const idx = n.path.indexOf('/');
    if (idx < 0) continue;
    const top = n.path.slice(0, idx);
    candidates.set(top, (candidates.get(top) || 0) + 1);
  }
  if (candidates.size !== 1) return nodes; // 多根或单层，不包

  const [top] = [...candidates.keys()];
  const prefix = top + '/';
  // 只有「所有文件都在同一个顶层目录下」才剥
  if (!nodes.every((n) => n.path.startsWith(prefix))) return nodes;

  return nodes.map((n) => ({ ...n, path: n.path.slice(prefix.length) }));
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
/**
 * 解析单个压缩文件。
 *
 * @param bytes 压缩包字节
 * @param filename 原始文件名（用于判定格式与 gzip 内层）
 */
export function parseArchiveFile(bytes: Uint8Array, filename: string): ArchiveParseResult {
  const detected = detectArchiveFormat(filename, bytes);
  if (!detected) {
    throw new ArchiveError(
      '无法识别压缩格式。支持 zip / tar / tar.gz / tgz；' +
        '也可以直接选择文件夹上传（页面上的「选择文件夹」按钮）。',
    );
  }
  let format = detected;

  let map: Map<string, Uint8Array>;
  if (format === 'zip') {
    map = unpackZip(bytes);
  } else if (format === 'tar') {
    map = untar(bytes, MAX_UNPACKED_BYTES);
  } else {
    // gzip 解出来的可能是 tar，也可能就是一个裸文件
    const inner = gunzipSync(bytes);
    if (inner.length > MAX_UNPACKED_BYTES) {
      throw new ArchiveError(`解压后超过 ${MAX_UNPACKED_BYTES / 1024 / 1024}MB 上限，请分批上传`);
    }
    const looksLikeTar = inner.length > 262 && detectArchiveFormat('', inner) === 'tar';
    if (looksLikeTar) {
      map = untar(inner, MAX_UNPACKED_BYTES);
      format = 'tar.gz';
    } else {
      // 单个 .gz 文件 —— 当成单条目
      const single = normalizePath(filename.replace(/\.(tar\.)?gz$/i, '') || 'unpacked');
      if (!single) throw new ArchiveError('无法解析 gzip 内容的文件名');
      map = new Map([[single, inner]]);
      format = 'gzip';
    }
  }

  return finalize(map, format, bytes.length);
}

/** 解析「文件夹 / 多文件」形态（前端 webkitdirectory 或多次选择） */
export function parseFileList(
  files: { path: string; bytes: Uint8Array }[],
): ArchiveParseResult {
  if (files.length === 0) throw new ArchiveError('没有选择任何文件');
  if (files.length > MAX_ENTRIES) {
    throw new ArchiveError(`文件数量过多（${files.length}），上限 ${MAX_ENTRIES} 个`);
  }
  let total = 0;
  const map = new Map<string, Uint8Array>();
  for (const f of files) {
    const path = normalizePath(f.path);
    if (!path) continue;
    total += f.bytes.length;
    if (total > MAX_UNPACKED_BYTES) {
      throw new ArchiveError(`所选文件总大小超过 ${MAX_UNPACKED_BYTES / 1024 / 1024}MB 上限`);
    }
    map.set(path, f.bytes);
  }
  return finalize(map, 'files', total);
}

/** 三种形态共用的收尾：归一 → 找 db → 收附件 → 统计 */
function finalize(map: Map<string, Uint8Array>, format: string, compressedBytes: number): ArchiveParseResult {
  // 1) 路径归一 + 条目数守卫
  const nodes: ArchiveNode[] = [];
  let unpacked = 0;
  let skipped = 0;

  for (const [rawPath, bytes] of map) {
    if (nodes.length >= MAX_ENTRIES) {
      skipped++;
      continue;
    }
    const path = normalizePath(rawPath);
    if (!path) {
      skipped++;
      continue;
    }
    // 体积守卫：逐个体检，超限的丢但继续（不整包失败，尽量多救一点）
    if (bytes.length > MAX_SINGLE_FILE_BYTES) {
      skipped++;
      continue;
    }
    unpacked += bytes.length;
    if (unpacked > MAX_UNPACKED_BYTES) {
      throw new ArchiveError(
        `解压后总大小超过 ${(MAX_UNPACKED_BYTES / 1024 / 1024).toFixed(0)}MB 上限，请分批上传`,
      );
    }
    const name = fixMojibake(path.slice(path.lastIndexOf('/') + 1));
    nodes.push({ path: path.slice(0, path.lastIndexOf('/') + 1) + name, name, bytes });
  }

  // 2) 膨胀比检查（仅对压缩包；文件夹形态没有"压缩前"的概念）
  if (format !== 'files' && compressedBytes > 8 * 1024 * 1024) {
    const ratio = unpacked / compressedBytes;
    if (ratio > MAX_RATIO) {
      throw new ArchiveError(
        `压缩比异常（${ratio.toFixed(0)}×），疑似恶意压缩包（zip bomb），已中止`,
      );
    }
  }

  const stripped = stripWrapper(nodes);

  // 3) 找 board.db —— 深浅优先、"upload" / 依赖目录排除
  const dbCandidate = pickDb(stripped);

  // 4) 收附件 —— uploads/ 下的、名字匹配 {32hex}.{ext} 的文件
  const attachments: AttachmentEntry[] = [];
  const seen = new Set<string>();
  for (const n of stripped) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    const lower = n.path.toLowerCase();
    // 必须落在 uploads/ 目录里（允许 uploads 位于任意深度，如 openboard/uploads/）
    const idx = lower.lastIndexOf('uploads/');
    if (idx < 0) continue;
    // uploads/ 之后不能再有子目录
    const after = n.path.slice(idx + 'uploads/'.length);
    if (after.includes('/')) continue;
    if (!ATTACHMENT_RE.test(n.name)) continue;
    if (seen.has(n.name)) continue;
    seen.add(n.name);
    attachments.push({
      key: n.name,
      bytes: n.bytes,
      contentType: mimeOf(n.name),
    });
  }

  return {
    nodes: stripped,
    dbBytes: dbCandidate?.bytes ?? null,
    dbPath: dbCandidate?.path ?? null,
    attachments,
    format,
    unpackedBytes: unpacked,
    skipped,
  };
}

/** 在归档里挑一个最像 board.db 的文件 */
function pickDb(nodes: ArchiveNode[]): ArchiveNode | null {
  const scored: { node: ArchiveNode; score: number }[] = [];
  for (const n of nodes) {
    const base = n.name.toLowerCase();
    if (!DB_BASENAMES.has(base)) continue;
    const lower = n.path.toLowerCase();
    // 排除明显的干扰项
    if (lower.includes('node_modules/') || lower.includes('.venv/') || lower.includes('site-packages/')) continue;
    if (lower.includes('uploads/')) continue;

    let score = 0;
    if (base === 'board.db') score += 100;
    if (!lower.includes('/')) score += 50; // 根目录最优
    if (lower.includes('backup') || lower.includes('备份') || lower.includes('old')) score -= 40;
    if (lower.includes('.wrangler')) score -= 60;
    scored.push({ node: n, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].node;
}
