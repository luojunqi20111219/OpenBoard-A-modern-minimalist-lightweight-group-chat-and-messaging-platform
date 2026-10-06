# 首屏性能优化记录

本文档记录 2026-10 这轮首屏优化的**做了什么、为什么这么做、怎么复现、别踩哪些坑**。

面向以后改这份代码的人（包括未来的自己）：如果你打算把某处"按需加载"改回静态引入，
或者调整 vendor 资源的加载顺序，**先读完对应小节再动手**。

---

## 一、成效总览

Playwright 在同一环境实测首屏（13 个请求的版本对比）：

| 指标 | 优化前 | 优化后 | 降幅 |
| --- | --- | --- | --- |
| 首屏传输量 | 311,502 B | **54,114 B** | **-82.6%** |
| 首屏解码量 | 857,509 B | **168,538 B** | **-80.3%** |
| 首屏请求数 | 13 | **9** | -4 |

> ⚠️ **重要提醒：首屏时间并没有明显改善**（DOM 可交互 1459→1885ms）。
> 原因见第六节 —— 瓶颈是网络 RTT，不是资源体积。
> 这轮优化的真实收益是**流量消耗降低 80%**，以及**在低延迟网络下加载更快**。
> 别拿沙箱里的时间数据当结论，这个环境 RTT 太高，测不出差异。

---

## 二、四项改动

### 1. Tailwind：Play CDN → 预编译 CSS

| | 前 | 后 |
| --- | --- | --- |
| 文件 | `tailwindcss-3.4.17.js` | `static/vendor/tailwind.css` |
| 体积 | 397 KB（未压缩） | 28 KB（gzip 5.9 KB） |
| 运行方式 | 浏览器运行时扫描 DOM 生成样式 | 构建期生成，零运行时开销 |

Play CDN 是**同步阻塞脚本**，会卡住渲染直到它跑完扫描。换成静态 CSS 后这层开销直接消失。

**⚠️ 加载顺序不能动！**

```html
<link href="/static/vendor/fontawesome/css/all.min.css" rel="stylesheet">
<link href="/static/vendor/tailwind.css" rel="stylesheet">  <!-- 必须在 FA 之后 -->
```

原因：Play CDN 是运行时把 `<style>` 注入到 `<head>` **末尾**（即在 FA 之后），
所以 Tailwind 的 `line-height` 能覆盖 FA 的。改成 `<link>` 后如果排在 FA 前面，
FA 会反过来覆盖 Tailwind，导致所有 `<i class="fa-* text-xl">` 图标行高偏小、整体变瘦。

这是 `tailwind-parity-test.mjs` 抓出来的真实回归（57 项差异，含 9 个 height、7 个 lineHeight）。
顺序改对后降到 41 项，只剩 `transitionProperty`；补完 webkit 前缀后归零。

**新增 class 后必须重新生成**，否则新类名没有样式：

```bash
mkdir -p /tmp/twbuild/src
cp public/index.html /tmp/twbuild/src/index.html
cd /tmp/twbuild
npx tailwindcss@3.4.17 -c tailwind.config.js -i src/input.css -o out.css --minify
# 补 webkit 前缀（见下方脚本），再拷回
cp out.css /path/to/openboard-cf/public/static/vendor/tailwind.css
```

改完**务必**跑一致性测试：

```bash
cd openboard-cf && node scripts/tailwind-parity-test.mjs   # 应为 0 差异
```

### 2. html5-qrcode：常驻加载 → 按需加载

366 KB，只有「开启摄像头扫码」和「扫描二维码图片」两个入口用到。
原来常驻 `<script defer>`，等于让每个访客（包括根本不扫码的）都下载。

现在由 `ensureHtml5Qrcode()` 在首次点击时动态插入 `<script>`，且只加载一次。

**别改回 `<script defer src>`。**

### 3. emoji-picker：静态标签 → 按需注入

**这是收益最大的一项。** 原来 `<emoji-picker>` 静态标签会在页面解析时触发：
`index.js` + `picker.js` + `database.js`（约 100 KB）+ `data.json`（439 KB）≈ 540 KB，实测占首屏解码量的 **51%**。而绝大多数用户根本不会点表情面板。

现在容器是空的，由 `ensureEmojiPicker()` 在首次点击时注入组件 + 绑事件。

关键点：
- `index.js` 的 `<script type="module">` 引用也要一起删（在 `<head>` 里），
  只改 `<emoji-picker>` 标签是不够的 —— 漏删会导致首页仍然触发 3 个 emoji 资源请求。
- 事件监听（`emoji-click` / `contextmenu` / `touchstart`）原本直接绑在静态元素上，
  脚本一加载就执行。改成动态注入后，必须等注入完成再绑 → 见 `bindEmojiPickerEvents()`。

**别改回静态标签。**

### 4. FontAwesome：全量字体 → 子集化

只保留页面实际用到的图标码点：

| 字体 | 前 | 后 | 降幅 |
| --- | --- | --- | --- |
| `fa-solid-900.woff2` | 126,828 B | **3,296 B** | -97.4% |
| `fa-regular-400.woff2` | 23,900 B | **868 B** | -96.4% |
| 合计 | 150,728 B | **4,164 B** | **-97.2%** |

**⚠️ 必须从 `.ttf` 子集化，不能从 `.woff2`。**

仓库里这份 `fa-solid-900.woff2` 用 fontTools 解码会报
`brotli.error: decoder failed`（brotli 版本不兼容）。从同目录的 `.ttf` 版本做就没问题。

```bash
python3 -m fontTools.subset webfonts/fa-solid-900.ttf \
    --unicodes=U+f000-f001,... \
    --flavor=woff2 --layout-features= --no-hinting --desubroutinize \
    --output-file=webfonts-subset/fa-solid-900.woff2
```

码点从 `all.min.css` 里提取。规则是 `.fa-xxx:before{content:"\XXXX"}`，
**注意别名形式**：同一条规则里可能有多个选择器，例如

```css
.fa-address-card:before,.fa-contact-card:before,.fa-vcard:before{content:"\f2bb"}
```

三个类名共用同一个码点，提取时都得算进去。

`all.min.css` 里对应改 `@font-face` 的 `src` 指向子集目录，并去掉 `.ttf` fallback
（子集目录里没有 ttf，留着会多一次 404 探测）。

**改完必须验证：**

```bash
cd openboard-cf
node scripts/fa-subset-check.mjs   # 逐图标像素比对
node scripts/fa-page-test.mjs      # 端到端页面验证
```

---

## 三、验证脚本

放在 `scripts/` 下，每次改动网页资源后跑一遍。

| 脚本 | 作用 | 期望结果 |
| --- | --- | --- |
| `tailwind-parity-test.mjs` | A 版（Play CDN）/B 版（预编译）视觉一致性<br>331 元素 × 40 computed style 逐项比对 | 0 差异 |
| `qr-lazy-test.mjs` | html5-qrcode 按需加载 | 4 项断言全过 |
| `emoji-lazy-test.mjs` | emoji-picker 按需加载<br>**关键断言**：首页请求 emoji 资源数 = 0 | 全过 |
| `fa-subset-check.mjs` | 字体验证：`FontFace` 显式加载 → canvas 渲染 → 逐像素 diff | 每个图标都有字形<br>差异 ≤ 5% |
| `fa-page-test.mjs` | 端到端：真实页面加载字体并统计 | 只加载 2 个子集字体<br>旧字体 0 个<br>43 图标全用 FA 字体族 |
| `live-perf-measure.mjs` | 线上首屏时序（Performance API） | 输出各阶段耗时 |
| `live-netcheck-run.mjs` | 线上体检页自动跑一遍 | 9 项检测结果 |

---

## 四、踩过的坑（都是真金白银换来的）

### 测量方法类

- ❌ `getBoundingClientRect().width` 测图标 —— **无效**。图标字体等宽，全是 81px。
- ❌ `getComputedStyle(el, '::before').content` —— **不可靠**，动态创建的元素拿不到。
- ❌ canvas `fillText` 渲染 PUA 字符 —— headless 下全 0 像素。
- ❌ `about:blank` 页面里用 `FontFace` 加载跨域字体 —— 报 `A network error occurred`，
  必须**先导航到真实同源页面**。
- ✅ 最终方案：`FontFace` API 显式加载 → canvas 渲染 → 逐像素 diff（容差 40，允许 ≤ 5%）。

### 环境/工具类

- **沙箱网络位置**：`colo=AMS`（阿姆斯特丹）。测自己的站点时 RTT 极高，
  数据不能代表国内用户体验。
- **CF 静态资源 MIME 陷阱**：根路径 `/` 没有扩展名，如果 `Content-Type` 不是 `text/html`，
  浏览器直接当**下载**处理，Playwright 报 `Download is starting`。
  本地起静态服务器时要特判：`const ext = isRoot ? '.html' : (dot > -1 ? p.slice(dot) : '')`
- **Playwright 脚本必须放项目目录内**，放 `/tmp` 会找不到 `playwright-core`。
- **`pngjs` 装不上**（依赖冲突），逐像素比对用别的方式实现。
- **CF 会自动做「去 `.html` 后缀」重定向**：`/netcheck.html` → 307 → `/netcheck` → 200。

### 体检页自身的两个假警报

`netcheck.html` 早期版本会误报，都已修正，**别改回去**：

1. 报「旧运行时编译器仍在线」—— 错。
   判定原则是**只看页面实际引用了什么**，不看服务器上有什么文件。
   旧文件留在服务器上不影响性能，只要不被引用就不会下载。
2. 报「扫码库未按需加载」—— 错。`performance.getEntriesByType` 把探测请求（带 `?t=`）
   也统计进去了，需要过滤掉 `?t=` 和 `netcheck` 相关的条目。
3. WebSocket `/api/ws` 匿名连接返回 401 —— 这是**正常**的，证明 TCP+TLS+路由+服务端
   整条链路通畅，只是没带 token。响应 < 5s 应判为「通」。

### 体积计算的认知修正

- **首页 HTML 实际只有 46 KB（gzip 后）**，不是 200 KB。
  Cloudflare 自动 gzip，用未压缩值算优化收益会**高估**。
- 体检页同时显示两个数字并明确标注：
  「传输 X KB（gzip 后）/ 解压后 Y KB」。
  `PerformanceResourceTiming.size` 是**解码后**大小，`transferSize` 才是实际传输量。

---

## 五、遗留问题

- **`fa-shield-halved` 在 FontAwesome 6.0.0 不存在**（该图标 6.1+ 才加入）。
  页面里用了这个类名，属于**既有 bug**，一直渲染不出来。这是本次优化之前就有的问题。
  修法：换成 6.0.0 里存在的近似图标，或升级 FA 版本。
- **`fa-brands-400` / `fa-v4compatibility` 字体仍保留全量** —— 页面未使用，未做子集化。
  如果确认全站不用，可以从 `all.min.css` 里摘掉相应 `@font-face`，省一次无关请求。

---

## 六、为什么首屏时间没变快

**瓶颈是网络 RTT，与资源大小无关。** 实测数据：

```
DNS 解析      272ms
TCP 连接      210ms   ← 纯 RTT
TLS 握手      218ms   ← 又一个 RTT
HTTP 首字节   506ms
完整下载     1185ms
```

光建立连接就要 428ms。对照组：`/favicon.ico` 只有 1 KB，**也要 778ms** ——
已经到底了，跟传多少数据没关系。

还有一个**反直觉但重要**的结论：**Worker 代码不是瓶颈。**
`diag_worker.py` 对比静态资源中位 778ms vs Worker 路径中位 806ms，
**差值仅 +28ms**。所以别再花力气优化 Worker 逻辑了。

**唯一有效的方向是降低 RTT** —— 也就是优选 IP。见 `tools/cf-optimize/`。

用户实测结果：25 个可用节点里 **21 个在洛杉矶**，只有 1 个 HKG。
说明运营商出口路由固定指向美国，154ms 已接近物理上限。

---

## 七、体检页

路径：**https://liuyan.luojunqi.xyz/netcheck**

（CF 自动去 `.html` 后缀，实际文件是 `public/netcheck.html`）

手机友好，自动复制报告，9 项检测：设备环境 / 服务器连通 / 静态资源下载 /
Tailwind 预编译 / 首屏资源统计 / 时区 / 扫码接口 / WebSocket / 旧运行时检查。

用来让用户（或同学）在**真实网络环境**下体检 —— 这比在沙箱里测有意义得多。
