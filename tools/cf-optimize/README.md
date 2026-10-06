# Cloudflare 访问加速 · 完整指南

> 针对「国内访问 `liuyan.luojunqi.xyz` 慢」这个问题。
> 实测当前状况：**`loc=CN` 但 `colo=FRA`** —— 识别为中国用户，流量却绕道德国法兰克福。

---

## 一、先搞清楚：你慢在哪

慢有三种，修法完全不同。别急着上工具，先定位。

| 症状 | 根因 | 该用什么 |
|---|---|---|
| 页面能开，但**加载慢**、图片转圈 | 路由绕远（走了欧美节点） | ⭐ **IP 优选**（本文重点） |
| 网页**打不开**、一直转 | 域名被污染 / IP 被封 | 换接入 IP |
| 静态资源偶尔**加载失败** | 资源加载超时 | 优化前端加载 + 优选 |

**你的情况是第一种**：域名已接入 Cloudflare（有 CDN），但你的 ISP 把流量
路由到了法兰克福。优选就是手动指定一个「离你近」的接入 IP。

---

## 二、三步走

### 第 1 步：扫出你这边最快的 IP

```bash
# 在你的 Windows 电脑上跑（不是在服务器上！）
python cf_ip_optimize.py --host liuyan.luojunqi.xyz
```

- 约 1~5 分钟，产出 `best_ips.txt` 和 `report.csv`
- **必须在国内网络跑** —— IP 优选的结果强依赖你所在位置和运营商（电信/联通/移动线路完全不同）

看 `report.csv` 里的 `colo` 字段：
- `colo=HKG` / `SIN` / `NRT` / `KIX` → 🇭🇰🇸🇬🇯🇵 **好，亚洲节点**
- `colo=SJC` / `LAX` → 🇺🇸 一般，但联通/移动有时很快
- `colo=FRA` / `AMS` / `LHR` → 🇩🇪🇳🇱🇬🇧 **差，绕欧洲了**

**建议一次性多跑几次**（不同时间段），取稳定靠前的几个 IP。

---

### 第 2 步：选一个方案应用

#### 方案 A · 本机 3Proxy（推荐先试这个）

**适用**：只加速你这一台 Windows 电脑。改动最小，5 分钟见效。

**原理**：3Proxy 在本机起一个反向代理，把发往 `liuyan.luojunqi.xyz:443`
的流量重定向到你优选的 IP，同时对上层保持原来的 SNI，所以 TLS 证书验证照常通过。

**步骤**：

1. 下载 3Proxy：https://github.com/3proxy/3proxy/releases
   （Windows 选 `3proxy-win64.zip`，解压到 `C:\3proxy\`）

2. 新建 `C:\3proxy\3proxy.cfg`，内容如下（**改域名和 IP**）：

```conf
# ============================================================
# 把发往 liuyan.luojunqi.xyz 的流量导向优选 IP
# ============================================================

# 内部 DNS 映射：让代理自己把域名解析到优选 IP
nserver 223.5.5.5
nserver 119.29.29.29
nscache 65536
timeouts 1 5 30 60 180 1800 15 60

# 监听本地 443
# 注意：需要管理员权限，且要先把系统里占用 443 的程序让开（一般是 IIS）
# 如果 443 被占用，改成其他端口，然后浏览器装 Proxy SwitchyOmega 指向它
log C:\3proxy\3proxy.log D
rotate 1
logformat "- +_L%t.%. %N.%p %E %U %C:%c %R:%r %O %I %h %T"

# ---- 在这里填入你扫出来的优选 IP ----
# 格式：fakeresolve 域名 IP
# 一个域名可以写多条，3proxy 会轮询
fakeresolve liuyan.luojunqi.xyz 104.27.102.99
fakeresolve liuyan.luojunqi.xyz 104.25.51.50

# 允许本机使用
allow *
# 监听 443，转发到上面 fakeresolve 指定的 IP
tcppm -i127.0.0.1 443 liuyan.luojunqi.xyz 443

# 如果你还需要加速别的 CF 站点，照抄一行即可
# fakeresolve 其他域名.com 104.27.102.99
```

3. **管理员身份**运行：

```cmd
cd C:\3proxy
3proxy.exe 3proxy.cfg
```

4. 验证生效：

```cmd
curl --resolve liuyan.luojunqi.xyz:443:127.0.0.1 https://liuyan.luojunqi.xyz/cdn-cgi/trace
```

看返回的 `colo=` 是不是你优选的节点。

> **更省事的替代**：如果懒得折腾代理，直接改 `C:\Windows\System32\drivers\etc\hosts`：
> ```
> 104.27.102.99  liuyan.luojunqi.xyz
> ```
> 缺点：一个域名一条记录，改完要重启浏览器；而且 IP 失效时网页直接打不开。
> 好处：零成本，先验证思路够用了。

---

#### 方案 B · 路由器 mosdns（全家设备加速）

**适用**：家里所有设备（手机、平板、电视）一起加速。需要有一台能刷路由器的设备
或者一台常开的软路由 / 树莓派。

**原理**：架一个本地 DNS，凡是解析结果落在 Cloudflare IP 段的域名，
一律**改写**成你的优选 IP。

```yaml
log:
  level: info
  file: "/tmp/mosdns.log"

servers:
  - exec: main_sequence
    listeners:
      - protocol: udp
        addr: ":53"

plugins:
  # 缓存
  - tag: lazy_cache
    type: cache
    args:
      size: 4096
      lazy_cache_ttl: 86400
      lazy_cache_reply_ttl: 30

  # 上游 DNS（用国内快速 DNS）
  - tag: forward_local
    type: fast_forward
    args:
      upstream:
        - addr: "udp://223.5.5.5"
        - addr: "udp://119.29.29.29"
        - addr: "https://dns.alidns.com/dns-query"
          idle_timeout: 30
          trusted: true

  # 匹配：解析结果是否落在 CF 的 IP 段
  - tag: response_IP_Cloudflare
    type: response_matcher
    args:
      ip:
        - "1.1.1.0/24"
        - "1.0.0.0/24"
        - "162.158.0.0/15"
        - "104.16.0.0/13"
        - "104.24.0.0/14"
        - "172.64.0.0/13"
        - "173.245.48.0/20"
        - "103.21.244.0/22"
        - "103.22.200.0/22"
        - "103.31.4.0/22"
        - "141.101.64.0/18"
        - "108.162.192.0/18"
        - "190.93.240.0/20"
        - "188.114.96.0/20"
        - "197.234.240.0/22"
        - "198.41.128.0/17"
        - "131.0.72.0/22"

  # 匹配：CNAME 指向 CF 的情况
  - tag: response_CNAME_Cloudflare
    type: response_matcher
    args:
      cname:
        - "domain:cdn.cloudflare.net"

  # 命中则改写为优选 IP
  # ⚠️ 若要针对多个域名用不同 IP，把这个插件复制多份，
  #    各配一条 response_matcher 按域名区分
  - tag: rewrite_to_best_ip
    type: blackhole
    args:
      ipv4: "104.27.102.99"    # ← 改成你扫出来的最优 IP

  - tag: main_sequence
    type: sequence
    args:
      exec:
        - lazy_cache
        - forward_local
        - if: response_CNAME_Cloudflare || response_IP_Cloudflare
          exec:
            - rewrite_to_best_ip
```

> **注意**：这个配置会把你**所有**走 CF 的域名都指向同一个 IP。
> 如果那个 IP 恰好不为某个域名服务，那个网站会打不开。
> 建议先小范围测试，或者只针对 `liuyan.luojunqi.xyz` 做定向改写。

---

#### 方案 C · 服务端 SaaS 优选 ⭐ **你选的就是这个**

**适用**：**所有用户**一起受益，不用每个人装工具。一次性配置。

**原理**：在 Cloudflare DNS 里加一条 CNAME，把 `liuyan.luojunqi.xyz`
指向一个「优选 IP 专用域名」，让 Cloudflare 把用户引导到更近的节点。

**前提**：
1. 域名 `luojunqi.xyz` 已接入 Cloudflare（✅ 已满足）
2. 你有该域名的 DNS 编辑权限
3. 域名在 CF 里是 **Proxied**（橙云）状态

**步骤**：

1. 在 Cloudflare Dashboard 里，把你扫出来的最优 IP 做成一条 A 记录，
   挂在一个**二级域名**上，例如 `cf-best.luojunqi.xyz` → `104.27.102.99`
   （**关掉橙云**，设成 DNS only 灰云，否则会绕回 CF 自己的路由）

2. 然后给主域名加 CNAME：

   ```
   类型:   CNAME
   名称:   liuyan
   目标:   cf-best.luojunqi.xyz
   代理:   已代理（橙云）
   ```

3. 因为 CF 支持 **SaaS（SSL for SaaS）**，即使 CNAME 指向别的 IP，
   证书和回源依然由 CF 处理，正常用户无感知。

> ⚠️ **更稳妥的做法**：不动主域名，而是新增一个域名，
> 例如 `liuyan2.luojunqi.xyz`，让用户在新域名上测试。
> 确认没问题再切换，避免一刀切导致所有人打不开。

---

## 三、重要提醒

### 优选 IP 会失效
CF 的边缘 IP 是动态调整的，今天快的 IP 可能明天就绕路了。
**建议每 1~2 周重跑一次** `cf_ip_optimize.py`。

### 别滥用
这些方法属于「见光死」类型。不要长时间、大流量占用单个 IP，
更不要拿去做机场。用得越狠，被封得越快。

### 三网差异很大
电信、联通、移动的国际出口线路完全不同。如果用户运营商混杂，
最优解可能是**按运营商分别优选**，或者干脆依赖 CF 自己的 Anycast
（也就是不做优选，接受 200ms）。

### 优选不等于一定更快
如果 CF 给你分配的节点本来就近（比如 `colo=NRT` 日本），
优选可能反而更慢。**先看 `colo`，再决定要不要优选。**

---

## 四、快速自查清单

```bash
# 1. 看当前接入节点
curl -s https://liuyan.luojunqi.xyz/cdn-cgi/trace | grep -E "colo|loc"

# 2. 看当前延迟
ping liuyan.luojunqi.xyz

# 3. 扫优选（在国内跑）
python cf_ip_optimize.py --host liuyan.luojunqi.xyz

# 4. 验证某个 IP 好不好
curl -sS -k --resolve liuyan.luojunqi.xyz:443:待测IP \
  https://liuyan.luojunqi.xyz/cdn-cgi/trace | grep -E "colo|loc"
```

`colo` 对照表（常见）：

| colo | 位置 | 国内体感 |
|---|---|---|
| HKG | 中国香港 | ⭐⭐⭐ 极佳 |
| SIN | 新加坡 | ⭐⭐⭐ 很好 |
| NRT / KIX | 日本东京/大阪 | ⭐⭐⭐ 很好 |
| ICN | 韩国首尔 | ⭐⭐⭐ 很好 |
| SJC / LAX | 美国西海岸 | ⭐⭐ 一般（联通/移动偶尔很好）|
| FRA / AMS / LHR | 欧洲 | ⭐ 差，绕远了 |
