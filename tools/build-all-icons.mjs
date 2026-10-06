/**
 * 全客户端图标构建 —— Android / 鸿蒙 / Windows 三端一次生成。
 *
 * 用法：
 *   node scripts/build-all-icons.mjs
 *
 * 源图：openboard-cf/scripts/icon-source.png（1254×1254，圆形外透明）
 *
 * ===========================================================================
 * 为什么要一个脚本统一生成，而不是各端各自处理
 * ===========================================================================
 *
 * 1) 视觉一致。同一张源图按各家规范切，避免「Android 上是一套、鸿蒙上又一套」。
 * 2) 规格正确。每个平台对图标尺寸/留白/透明度的要求都不一样，集中写清楚。
 * 3) Flutter 的图标是通过 pubspec.yaml 引用鸿蒙那份 app_icon.png 的
 *    （image_path 指向 ../OpenBoardHarmony/...），所以改鸿蒙 = 改 Flutter，
 *    这里不用单独处理 Flutter，只需保证鸿蒙产物正确。
 *
 * ===========================================================================
 * 各端规格与坑
 * ===========================================================================
 *
 * 【Android】
 *   传统图标（minSdk 24 那批设备用）：
 *     mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192
 *     ⚠️ 原项目 5 个目录全是同一张 256×256 —— 等于没做密度适配。
 *        小密度屏白加载大图，且 Android 缩放后偏糊。这里改成正确的分级尺寸。
 *
 *   adaptive icon（Android 8+，API 26）：
 *     必须新建 mipmap-anydpi-v26/ic_launcher.xml 声明「前景+背景」两层。
 *     ⚠️ 不做这个的话，Android 8+ 会把传统图标塞进系统白底圆角方框里 ——
 *        圆形图标外面会多出一圈白边，非常显眼。
 *
 *     ⚠️ 安全区：adaptive icon 会被系统裁成各种形状（圆/方/水滴），
 *        前景内容必须限制在中间 66% 的圆内，否则会被切掉。
 *        背景层是满幅的（108dp 里的 108dp），前景只有中间 72dp 是安全区。
 *
 *     ⚠️ ic_launcher_round.png 不用单独做 —— 有 adaptive icon 后，
 *        圆形设备直接用那套。但为了兼容老设备（API 24-25 且要求圆图标），
 *        还是保留一份圆形裁切的。
 *
 * 【鸿蒙 HarmonyOS】
 *   app_icon.png      256×256  传统图标
 *   foreground.png   1024×1024 分层图标前景（透明底，内容在中间安全区）
 *   background.png   1024×1024 分层图标背景（满幅不透明）
 *   startIcon.png     256×256  启动页图标
 *
 *   ⚠️ 新图标本身是「完整圆形带蓝底」，不能直接丢给前景层 ——
 *      会和背景层叠成「圆中圆」。而且也不能用纯色做背景（接不上边缘渐变）。
 *      最终方案：
 *        前景 = 原图内容裁到中间安全区（圆占安全区 97%）
 *        背景 = 把原图最外圈颜色沿半径方向「拉伸」铺满画布（radial_extend）
 *      这样两层在圆的边界处颜色完全连续，合成后看不出接缝。
 *
 * 【Windows 桌面】
 *   resource.rc 里写的是 `101 ICON DISCARDABLE "favicon.ico"`，
 *   所以要更新仓库根目录的 favicon.ico（不是 openboard-cf 里那份）。
 *   规格同浏览器：多尺寸 16/24/32/48/64/128/256，
 *   这样任务栏、Alt+Tab、文件资源管理器各取所需。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本脚本在 tools/ 下，所以仓库根目录是它的上一级。
// ⚠️ 不要写成 join(dirname, '..', '..') —— 那会跳到 /workspace 外面去。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'openboard-cf', 'scripts', 'icon-source.png');

const ANDROID_RES = join(ROOT, 'OpenBoardAndroid', 'app', 'src', 'main', 'res');
const HARMONY_APP = join(ROOT, 'OpenBoardHarmony', 'AppScope', 'resources', 'base', 'media');
const HARMONY_ENTRY = join(ROOT, 'OpenBoardHarmony', 'entry', 'src', 'main', 'resources', 'base', 'media');

if (!existsSync(SRC)) {
  console.error(`❌ 找不到源图：${SRC}`);
  process.exit(1);
}

const py = `
import sys, os
from PIL import Image, ImageDraw

src = r"""${SRC}"""
ANDROID_RES = r"""${ANDROID_RES}"""
HARMONY_APP = r"""${HARMONY_APP}"""
HARMONY_ENTRY = r"""${HARMONY_ENTRY}"""
ROOT = r"""${ROOT}"""

im = Image.open(src).convert("RGBA")
W, H = im.size

# ---------------------------------------------------------------------------
# 规整源图：裁到内容 → 留 6% 边距 → 居中贴到正方形
# （和 build-icons.mjs 同样的处理，保证网页和客户端图标视觉一致）
# ---------------------------------------------------------------------------
bbox = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
if not bbox:
    sys.exit("ERROR: 源图全透明")
content = im.crop(bbox)
cw, ch = content.size
PAD = 0.06
side = int(round(max(cw, ch) / (1 - PAD * 2)))
base = Image.new("RGBA", (side, side), (0, 0, 0, 0))
base.paste(content, ((side - cw) // 2, (side - ch) // 2), content)

def rs(size):
    return base.resize((size, size), Image.LANCZOS)

def rs_tight(size):
    """
    用【未加边距】的原始内容缩放到 size×size。
    分层图标（adaptive / 鸿蒙）要用这个 —— 因为那两套规范里
    外层本来就是透明画布，边距由我们按各自的安全区规则精确控制，
    不能沿用 base 里为「方形传统图标」准备的 6% 边距。
    ⚠️ 之前在这里踩坑：误用 rs() 导致边距叠加两次，
       圆直径只占画布 53%，图标缩成小小一个。
    """
    return content.resize((size, size), Image.LANCZOS)

print(f"源图 {W}x{H} → 规整 {side}x{side}\\n")

# ===========================================================================
# 1. Android 传统图标
# ===========================================================================
# mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192（Android 官方倍率 1/1.5/2/3/4）
ANDROID_DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}
print("【Android 传统图标】")
for d, sz in ANDROID_DENSITIES.items():
    p = os.path.join(ANDROID_RES, f"mipmap-{d}")
    os.makedirs(p, exist_ok=True)
    img = rs(sz)
    img.save(os.path.join(p, "ic_launcher.png"))
    img.save(os.path.join(p, "ic_launcher_round.png"))
    print(f"  mipmap-{d:<8s} {sz:>3d}x{sz:<3d}  ic_launcher.png / ic_launcher_round.png")

# ===========================================================================
# 2. Android adaptive icon
# ===========================================================================
#
# 前景层画布是 108dp，但只有中间 72dp 是安全区（系统裁切不会碰到的范围）。
# 换成像素：前景图给 432×432（xxxhdpi 108dp 的 4 倍），
# 内容要限制在中间 432 * 72/108 = 288px 内。
#
# ⚠️ 这里踩过两次坑，都是「图标缩成一小团」：
#    第一次：按「安全区的 92%」算，圆直径只占画布 53.5%。
#    第二次：改成 97% 但仍在用带 6% 边距的 base，只涨到 56.5%。
#    根因是【边距叠加了两次】：base 里已有 6% 内边距，缩放时又留一次。
#    分层图标必须用 rs_tight()（未加边距的原始内容），边距由安全区规则单独控制。
#
#    正确算法：圆的直径 = 画布 × 72/108（安全区比例）× 0.97（抗锯齿余量）
print()
print("【Android adaptive icon (API 26+)】")

ANDROID_ANYDPI = os.path.join(ANDROID_RES, "mipmap-anydpi-v26")
os.makedirs(ANDROID_ANYDPI, exist_ok=True)

FG_SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
for d, canvas_sz in FG_SIZES.items():
    p = os.path.join(ANDROID_RES, f"mipmap-{d}")
    inner = int(round(canvas_sz * (72 / 108) * 0.97))
    fg = Image.new("RGBA", (canvas_sz, canvas_sz), (0, 0, 0, 0))
    art = rs_tight(inner)
    off = (canvas_sz - inner) // 2
    fg.paste(art, (off, off), art)
    fg.save(os.path.join(p, "ic_launcher_foreground.png"))

# 背景：满幅不透明，且必须与前景外缘「无缝」。
#
# ⚠️ 这里反复踩坑，记录完整思路免得后人重试：
#
#   试法 1：用采样出的平均色做纯色背景
#     → 合成后看到明显「圆中圆」。因为图标外缘本身是渐变的
#       （右上高光 rgb(30,180,252) → 左下 rgb(28,115,253)），纯色接不上。
#
#   试法 2：把源图整体放大 1.6 倍当背景
#     → 更糟。放大后气泡也跟着放大，和前景的气泡叠成「双气泡重影」。
#
#   最终解法：径向拉伸。取源图最外圈那一环像素，按半径方向向外拉伸铺满画布。
#     由于圆外是透明的，拉伸的是「圆内最靠边 2% 的那圈」——
#     这圈颜色本来就是图标外缘的颜色，拉伸出去后与前景边缘完全连续，零接缝。
#     而且不会引入任何额外的图形元素（不像放大整张图会带出气泡）。
def radial_extend(src_img, out_size):
    """把 src_img 最外圈的颜色按半径方向拉伸，生成 out_size 的方形背景。"""
    from PIL import Image as _I
    src = src_img.convert("RGBA")
    sw, sh = src.size
    scx, scy = sw / 2.0, sh / 2.0
    # 找出圆形半径
    radius = 0
    for x in range(int(scx), sw):
        if src.getpixel((x, int(scy)))[3] < 200:
            radius = x - scx
            break
    if radius <= 0:
        radius = min(sw, sh) * 0.44

    # 采样环：取圆内最靠边的一圈作为「外缘色」
    #
    # ⚠️ 采样后必须做一次角向平滑，否则背景会出现放射状条纹 ——
    #    因为相邻角度的采样值有跳变（尤其原图有噪点/渐变带时），
    #    直接按角度取色会画出可见的「光芒」纹路。踩过这个坑。
    SAMPLE_STEPS = 1440
    ring = []
    for i in range(SAMPLE_STEPS):
        import math as _m
        ang = i * 2 * _m.pi / SAMPLE_STEPS
        R = radius * 0.985
        x = int(scx + R * _m.cos(ang))
        y = int(scy + R * _m.sin(ang))
        x = max(0, min(sw - 1, x))
        y = max(0, min(sh - 1, y))
        ring.append(src.getpixel((x, y))[:3])

    # 角向滑动平均（窗口 ±12 个采样点，环状回绕，所以分量做两遍）
    WIN = 12
    smoothed = []
    n = len(ring)
    for i in range(n):
        acc = [0, 0, 0]
        cnt = 0
        for k in range(-WIN, WIN + 1):
            c = ring[(i + k) % n]
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            cnt += 1
        smoothed.append((acc[0] // cnt, acc[1] // cnt, acc[2] // cnt))
    ring = smoothed

    # 画径向渐变：每圈取对应角度的颜色（这里简化成整圈同色时也够用，
    # 但要保留角向变化才能接住右上高光/左下暗部，所以按角度插值）
    out = _I.new("RGB", (out_size, out_size), (255, 255, 255))
    px = out.load()
    import math as _m
    ocx, ocy = out_size / 2.0 - 0.5, out_size / 2.0 - 0.5
    maxd = _m.hypot(ocx, ocy)
    for y in range(out_size):
        for x in range(out_size):
            dx, dy = x - ocx, y - ocy
            d = _m.hypot(dx, dy)
            # 归一化到环上的角度索引
            idx = int((_m.atan2(dy, dx) % (2 * _m.pi)) / (2 * _m.pi) * SAMPLE_STEPS) % SAMPLE_STEPS
            r0, g0, b0 = ring[idx]
            # 越靠外稍微压暗一点点，做出自然的纵深（否则纯平铺看着发假）
            t = min(1.0, d / maxd)
            k = 1.0 - 0.06 * t
            px[x, y] = (int(r0 * k), int(g0 * k), int(b0 * k))
    return out


for d, sz in FG_SIZES.items():
    p = os.path.join(ANDROID_RES, f"mipmap-{d}")
    radial_extend(rs_tight(sz), sz).save(os.path.join(p, "ic_launcher_background.png"))

# adaptive icon 的 XML 声明
#
# ⚠️ <adaptive-icon> 只能在 v26+ 用，所以放 mipmap-anydpi-v26。
#    API 24/25 会回退到上面的 mipmap-*/ic_launcher.png（传统图标）。
xml = '''<?xml version="1.0" encoding="utf-8"?>
<!--
  Android 8.0 (API 26) 起的分层图标。

  ⚠️ 别删这个文件。删了的话 Android 8+ 会把传统 ic_launcher.png
     塞进系统默认的白底圆角方框里 —— 我们的图标是圆形的，
     四周就会露出一圈白边。这个文件让系统用自己的形状去裁前景层。

  background 用纯色渐变，foreground 是透明底的气泡图案，
  由 scripts/build-all-icons.mjs 生成，改图标请改源图后重跑该脚本。
-->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
'''
for f in ["ic_launcher.xml", "ic_launcher_round.xml"]:
    open(os.path.join(ANDROID_ANYDPI, f), "w", encoding="utf-8").write(xml)
print(f"  mipmap-anydpi-v26/  ic_launcher.xml + ic_launcher_round.xml")

# ===========================================================================
# 3. 鸿蒙
# ===========================================================================
#
# ⚠️ 鸿蒙的分层图标 foreground 安全区是中间 66% 左右（不同文档口径略有差异，
#    实测按 66% 留白在所有主题下都不会被裁）。
#    但我们的图标本身是完整圆形，直接缩到 66% 会显得小；
#    按 78% 放，视觉上和系统其它图标接近，且圆形边缘仍在安全区内。
print()
print("【鸿蒙 HarmonyOS】")
HARMONY_FG_RATIO = 0.78
for d in [HARMONY_APP, HARMONY_ENTRY]:
    os.makedirs(d, exist_ok=True)

# app_icon.png —— 传统图标（也是 Flutter 引用的那份，见 pubspec.yaml）
#
# ⚠️ 这个文件是 Flutter 的图标来源（pubspec 里 image_path 指向它），
#    改这里等于同时改了 Flutter，不需要单独处理 Flutter。
rs(256).save(os.path.join(HARMONY_APP, "app_icon.png"))
rs(256).save(os.path.join(HARMONY_ENTRY, "app_icon.png"))
print("  app_icon.png      256x256   (AppScope + entry，Flutter 也引用这份)")

# startIcon.png —— 启动页
rs(256).save(os.path.join(HARMONY_ENTRY, "startIcon.png"))
print("  startIcon.png     256x256   启动页")

# background.png —— 分层背景，满幅不透明。
#
# ⚠️ 同 Android：不能用纯色或自己画的渐变，否则和前景外缘接不上，
#    合成后会看到「圆中圆」。这里同样用「源图放大 1.6 倍居中」的办法，
#    让背景颜色跟前景边缘自然连续。
FG = 1024
inner = int(FG * HARMONY_FG_RATIO)
fg = Image.new("RGBA", (FG, FG), (0, 0, 0, 0))
art = rs_tight(inner)
off = (FG - inner) // 2
fg.paste(art, (off, off), art)
fg.save(os.path.join(HARMONY_APP, "foreground.png"))
print(f"  foreground.png    {FG}x{FG}  分层前景（内容占 {HARMONY_FG_RATIO*100:.0f}%）")

# background.png —— 分层背景，满幅不透明。
# ⚠️ 同 Android，必须用「径向拉伸」才能和前景外缘无缝，不能用纯色或放大源图。
#    详细原因见上面 radial_extend 的注释。
radial_extend(rs_tight(FG), FG).save(os.path.join(HARMONY_APP, "background.png"))
print(f"  background.png    {FG}x{FG}  分层背景（径向拉伸，与前缘无缝）")
# ===========================================================================
# 4. Windows 桌面（仓库根目录的 favicon.ico，被 resource.rc 引用）
# ===========================================================================
print()
print("【Windows 桌面】")
win_src = rs(256)
win_src.save(os.path.join(ROOT, "favicon.ico"), format="ICO")
import struct
_d = open(os.path.join(ROOT, "favicon.ico"), "rb").read()
_cnt = struct.unpack("<HHH", _d[:6])[2]
_sz = []
_o = 6
for _ in range(_cnt):
    _w = _d[_o] or 256
    _sz.append(_w)
    _o += 16
print(f"  favicon.ico       含 {_cnt} 个尺寸 {sorted(_sz)}")
assert _cnt >= 5, f"ICO 尺寸太少：{sorted(_sz)}"

# ===========================================================================
# 5. 自检 —— 确认每个该生成的文件都在，且规格正确
# ===========================================================================
#
# ⚠️ 必须自检。前面已经吃过一次亏：Pillow 保存多尺寸 ICO 时静默丢尺寸，
#    「保存成功」不等于「内容正确」。这里逐项核对文件存在性与尺寸。
print()
print("【自检】")
problems = []

def check(path, expect_size=None, expect_alpha=None):
    if not os.path.exists(path):
        problems.append(f"缺失：{path}")
        return
    img = Image.open(path)
    if expect_size and img.size != (expect_size, expect_size):
        problems.append(f"尺寸不符：{path} 期望 {expect_size}x{expect_size} 实际 {img.size}")
    if expect_alpha is not None:
        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        if expect_alpha and not has_alpha:
            problems.append(f"应带透明通道但实际不透明：{path} mode={img.mode}")
        if (not expect_alpha) and img.mode in ("RGBA", "LA"):
            # 背景层若带 alpha 且存在透明像素，叠在系统壁纸上会露底
            if img.convert("RGBA").getchannel("A").getextrema()[0] < 255:
                problems.append(f"背景层含透明像素，会露出系统壁纸：{path}")

for d, sz in ANDROID_DENSITIES.items():
    base = os.path.join(ANDROID_RES, f"mipmap-{d}")
    check(os.path.join(base, "ic_launcher.png"), sz, True)
    check(os.path.join(base, "ic_launcher_round.png"), sz, True)
for d, sz in FG_SIZES.items():
    base = os.path.join(ANDROID_RES, f"mipmap-{d}")
    check(os.path.join(base, "ic_launcher_foreground.png"), sz, True)
    check(os.path.join(base, "ic_launcher_background.png"), sz, False)

for f in ["ic_launcher.xml", "ic_launcher_round.xml"]:
    p = os.path.join(ANDROID_ANYDPI, f)
    if not os.path.exists(p):
        problems.append(f"缺失：{p}")
    else:
        t = open(p, encoding="utf-8").read()
        for kw in ["<adaptive-icon", "@mipmap/ic_launcher_background", "@mipmap/ic_launcher_foreground"]:
            if kw not in t:
                problems.append(f"{f} 内容不完整，缺 {kw}")

check(os.path.join(HARMONY_APP, "app_icon.png"), 256, True)
check(os.path.join(HARMONY_ENTRY, "app_icon.png"), 256, True)
check(os.path.join(HARMONY_ENTRY, "startIcon.png"), 256, True)
check(os.path.join(HARMONY_APP, "foreground.png"), 1024, True)
check(os.path.join(HARMONY_APP, "background.png"), 1024, False)

# Flutter 靠 pubspec 引用鸿蒙那份 app_icon.png —— 确认它还是有效路径
_pubspec = os.path.join(ROOT, "OpenBoardFlutter", "pubspec.yaml")
if os.path.exists(_pubspec):
    _t = open(_pubspec, encoding="utf-8").read()
    if "OpenBoardHarmony/entry/src/main/resources/base/media/app_icon.png" in _t:
        print("  Flutter    → 引用鸿蒙 app_icon.png（已同步更新）")
    else:
        print("  ⚠️ Flutter 的 image_path 变了，请确认新路径下的图标也是这套")

if problems:
    print()
    for p in problems:
        print(f"  ❌ {p}")
    sys.exit(1)
print("  全部通过 ✅")
`;

writeFileSync('/tmp/_build_all_icons.py', py, 'utf8');
try {
  const out = execFileSync('python3', ['/tmp/_build_all_icons.py'], { encoding: 'utf8' });
  process.stdout.write(out);
  console.log('\n✅ 全客户端图标已生成');
} catch (e) {
  process.stdout.write(e.stdout || '');
  process.stderr.write(e.stderr || '');
  process.exit(1);
}
