# Termux 部署指南

> 用手机跑 Cloudflare 优选。**完全可行**，而且有个额外好处：
> 手机随时能测 —— 换 WiFi、换位置、切运营商流量都能跑，
> 比电脑更容易找到「此时此刻」的最优 IP。

---

## 为什么值得用手机测

你的宽带和手机**走的不是同一条路**。

```
宽带    → colo=LAX   （美国西海岸）
手机 4G → ？         （很可能完全不同，移动经常比宽带更差）
```

手机测出来的结果，反映的是**移动网络下的真实路由**。
如果你平时主要用手机 App，那这个结果比宽带测的更有参考价值。

---

## 一、装 Termux

**别用 Google Play 版本** —— 那个版本早就停止更新了，装不了新包。

从这两个地方下载：

- **F-Droid**：https://f-droid.org/packages/com.termux/
- **GitHub Releases**：https://github.com/termux/termux-app/releases

下载 `termux-app_v0.118.x+github-debug_universal.apk`（universal 版最保险）。

> ⚠️ 华为/荣耀手机如果没有 Google 服务，直接用 GitHub 的 APK，不影响使用。

---

## 二、装依赖（三条命令）

打开 Termux，逐行粘贴：

```bash
pkg update -y && pkg upgrade -y

pkg install -y python curl

# 可选，但强烈建议：这样扫完能直接导出到手机存储
termux-setup-storage
```

`termux-setup-storage` 会弹权限申请，**点允许**。

验证：

```bash
python --version
curl --version | head -1
```

能看到版本号就行。

---

## 三、把脚本放进手机

### 方式 A · 直接下载（最简单）

如果手机能访问 GitHub：

```bash
pkg install -y wget
cd ~
wget https://ghfast.top/https://raw.githubusercontent.com/luojunqi20111219/OpenBoard-.../main/tools/cf-optimize/cf_ip_optimize.py
```

### 方式 B · 从电脑拷过去（推荐）

1. 电脑上把 `cf-optimize` 整个目录传到手机（微信/QQ/数据线都行）
2. 文件会落在手机的 `Download` 目录
3. Termux 里：

```bash
cd ~
cp -r ~/storage/downloads/cf-optimize .
cd cf-optimize
```

> **注意**：如果出现 `cp: cannot access` 之类的报错，
> 说明 `termux-setup-storage` 没执行或没给权限。

### 方式 C · 直接手输（不想传文件的话）

实在嫌麻烦，也可以只拷 `cf_ip_optimize.py` 一个文件，
然后 `termux_setup.sh` 不用管，直接跑 Python：

```bash
python cf_ip_optimize.py --host liuyan.luojunqi.xyz --timeout 4 --concurrency 24
```

---

## 四、跑起来

```bash
cd ~/cf-optimize
bash termux_setup.sh
```

这个脚本会自动：
1. 检查依赖
2. **先告诉你当前接入的是哪个节点**（基线）
3. 扫 229 个候选 IP
4. 结果导出到手机「下载」目录

**大概 1~5 分钟。建议把屏幕常亮打开**，某些机型息屏会断网。

> 想省电/省流量，可以缩小规模：
> ```bash
> python cf_ip_optimize.py --host liuyan.luojunqi.xyz --concurrency 12 --top 10
> ```

---

## 五、看结果

```bash
cat report.csv
```

重点看 **`colo`** 这一列：

| colo | 位置 | 评价 |
|---|---|---|
| HKG | 中国香港 | ⭐⭐⭐ 极佳 |
| SIN | 新加坡 | ⭐⭐⭐ 很好 |
| NRT / KIX | 日本 | ⭐⭐⭐ 很好 |
| ICN | 韩国 | ⭐⭐⭐ 很好 |
| TPE | 中国台北 | ⭐⭐⭐ 很好 |
| SJC / LAX / SEA | 美国西岸 | ⭐⭐ 一般 |
| FRA / AMS / LHR | 欧洲 | ⭐ 差，绕远了 |

**最优 IP 应该是「延迟最低 且 colo 在亚洲」的那个**，别只看延迟 ——
有时候延迟 140ms 走法兰克福，还不如 180ms 走香港。

---

## 六、踩坑备忘

### Termux 特有的问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `pkg: command not found` | 装的是 Play Store 版本 | 换 F-Droid/GitHub 版 |
| 扫描全部超时 | 息屏断网 / 省电模式 | 开发者选项里关掉电池优化 |
| 结果文件找不到 | 没跑 `termux-setup-storage` | 跑一次并允许权限 |
| `Permission denied` | 脚本没执行权限 | `chmod +x termux_setup.sh` |
| 卡在 `pkg upgrade` | 镜像慢 | `termux-change-repo` 换清华源 |

### 换国内镜像源（强烈建议，快很多）

```bash
termux-change-repo
```

选 `Mirrors by Tsinghua` 或 `Mirrors by USTC`，然后：

```bash
pkg update -y
```

### 后台跑（不被息屏打断）

```bash
# 装 termux-wake-lock
pkg install -y termux-api
termux-wake-lock

# 跑完记得释放
termux-wake-unlock
```

---

## 七、把结果发我

跑完后，我要看的是 `report.csv` 的 **`colo` 列和 `time_connect` 列**。

最快的办法：

```bash
cat report.csv
```

然后截图或复制前 20 行给我。

或者直接看总结：

```bash
cat best_ips.txt
```

---

## 八、然后呢

拿到你的数据后，我会判断：

- **如果最优 IP 是 HKG/SIN/NRT** → 配 SaaS 优选，所有用户受益
- **如果全是美国** → 说明 CF 没给国内优质线路，需要换思路
  （可能是回源慢，或者要考虑其他方案）
- **如果延迟都 >200ms** → 优选救不了，得从回源侧想办法

**先跑，再定。** 没有你的实测数据，任何方案都是猜。
