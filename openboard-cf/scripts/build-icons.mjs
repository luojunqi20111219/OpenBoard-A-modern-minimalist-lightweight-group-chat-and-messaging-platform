/**
 * 图标构建脚本 —— 从一张源图生成全平台图标。
 *
 * 用法：
 *   1. 把新图标（正方形 PNG，建议 512 以上）放到 scripts/icon-source.png
 *   2. node scripts/build-icons.mjs
 *
 * 产物（都在 public/ 下）：
 *   favicon.ico            多尺寸 ICO（16/32/48/64），浏览器标签页用
 *   apple-touch-icon.png   180×180，iOS 添加到主屏幕用
 *   icon-192.png           192×192，Android/PWA 用
 *   icon-512.png           512×512，PWA 启动画面用
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本，而不是直接拿源图另存为几个尺寸：
 *
 * 1) 源图的内容通常不居中、占比过大。实测那张 1254×1254 的图，
 *    不透明区域是 (65,65)-(1180,1187)，左右边距差 9px，且占了 89% 画布。
 *    直接缩放的话，16×16 下圆形几乎贴边，看着又大又挤。
 *    所以这里统一「裁剪到内容 → 留 6% 边距 → 居中贴回正方形画布」。
 *
 * 2) iOS 的 apple-touch-icon **不能用透明背景** —— 系统会自己填黑，
 *    圆形外会变成黑角。所以这一个要额外垫一层不透明底色。
 *
 * 3) .ico 是多尺寸容器，PIL 的 save 支持传 sizes 列表，
 *    但不能直接对 RGBA 大图一次搞定，得逐尺寸 resize 再打包，
 *    否则 Windows 上小尺寸会糊。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SRC = join(ROOT, 'scripts', 'icon-source.png');

if (!existsSync(SRC)) {
  console.error(`❌ 找不到源图：${SRC}`);
  console.error('   请把正方形 PNG 放过去再跑。');
  process.exit(1);
}

// 用 Python + Pillow 做实际处理 —— Node 这边没有轻量的高质量重采样库。
const py = `
import sys
from PIL import Image

src = r"""${SRC}"""
public = r"""${PUBLIC}"""

im = Image.open(src).convert("RGBA")
W, H = im.size

# --- 1. 裁剪到真实内容，再去掉边缘噪点 ---
# alpha > 8 才算内容，避免把极淡的抗锯齿像素当成边界
bbox = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
if not bbox:
    print("ERROR: 源图全是透明的")
    sys.exit(1)
content = im.crop(bbox)
cw, ch = content.size

# --- 2. 居中贴到正方形画布，留 6% 边距 ---
# 6% 是实测比较舒服的值：再小则 16×16 下贴边，再大则图标显得小。
PAD_RATIO = 0.06
side = int(round(max(cw, ch) / (1 - PAD_RATIO * 2)))
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(content, ((side - cw) // 2, (side - ch) // 2), content)

# --- 3. 生成 .ico（多尺寸）---
#
# ⚠️ 这里踩了两个坑，都记下来免得重蹈：
#
#    坑 1：im.save(x.ico, sizes=[...], append_images=[...])
#      sizes 和 append_images 同时用时行为未定义 —— 最终文件里只剩第一个尺寸
#      （16×16），其余静默丢弃，不报错。这个 bug 很隐蔽。
#
#    坑 2：以为 Pillow 存单尺寸 ICO 就真只存一个。
#      实际它会按「等比递减」自动生成一整组。
#      实测：源 32 → [16,24,32]；源 48 → [16,24,32,48]；
#            源 64 → [16,24,32,48,64]；源 256 → [16,24,32,48,64,128,256]
#      sizes 参数只是【过滤器】，不是「要生成哪些」。
#
#    所以正确做法就是：从 64×64 存一次，拿到 16/24/32/48/64 五档，
#    正好覆盖 Windows 任务栏、浏览器标签页、高清屏书签等所有场景，16.8KB。
#    额外传 sizes 反而会把结果弄坏。
canvas.resize((64, 64), Image.LANCZOS).save(public + "/favicon.ico", format="ICO")

# --- 4. iOS 主屏图标：必须不透明 ---
#
# ⚠️ apple-touch-icon 如果带透明通道，iOS 会自己填成黑色，
#    圆形外那一圈就变成黑角，非常难看。所以垫一层白色底。
apple_bg = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
apple = Image.alpha_composite(apple_bg, canvas).convert("RGB")
apple.resize((180, 180), Image.LANCZOS).save(public + "/apple-touch-icon.png")

# --- 5. PWA 图标（这两种保留透明，Android 自己会处理）---
canvas.resize((192, 192), Image.LANCZOS).save(public + "/icon-192.png")
canvas.resize((512, 512), Image.LANCZOS).save(public + "/icon-512.png")

# --- 6. 自检：确认 ICO 里真的有多尺寸 ---
#
# ⚠️ 必须自检。Pillow 那次静默丢尺寸的教训说明：
#    「保存成功」不等于「内容正确」。这里直接读回文件头校验目录项。
import struct
EXPECTED_ICO_SIZES = [16, 24, 32, 48, 64]
_ico = open(public + "/favicon.ico", "rb").read()
_cnt = struct.unpack("<HHH", _ico[:6])[2]
_found = []
_off = 6
for _ in range(_cnt):
    _w, _h, _c, _r, _pl, _bpp, _sz, _o = struct.unpack("<BBBBHHII", _ico[_off:_off + 16])
    _found.append(_w or 256)
    _off += 16
assert sorted(_found) == EXPECTED_ICO_SIZES, \
    f"ICO 尺寸不对！期望 {EXPECTED_ICO_SIZES}，实际 {sorted(_found)}"
print(f"自检通过：ICO 内含 {len(_found)} 个尺寸 {sorted(_found)}")

# --- 7. 报告 ---
print(f"源图            {W}x{H}")
print(f"内容裁剪        ({bbox[0]},{bbox[1]})-({bbox[2]},{bbox[3]})  {cw}x{ch}")
print(f"规整后画布      {side}x{side}（边距 {PAD_RATIO*100:.0f}%）")
import os
for f in ["favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]:
    p = os.path.join(public, f)
    print(f"  {f:24s} {os.path.getsize(p):>8,d} B")
`;

writeFileSync(join('/tmp', '_build_icons.py'), py, 'utf8');
const out = execFileSync('python3', ['/tmp/_build_icons.py'], { encoding: 'utf8' });
process.stdout.write(out);
console.log('\n✅ 图标已生成到 public/');
