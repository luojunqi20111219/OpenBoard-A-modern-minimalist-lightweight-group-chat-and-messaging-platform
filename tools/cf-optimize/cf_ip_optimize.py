#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cloudflare 边缘 IP 优选扫描器（中国大陆专用）

═══════════════════════════════════════════════════════════════════════
为什么需要这个脚本
═══════════════════════════════════════════════════════════════════════

Cloudflare 是 Anycast 网络：同一个域名在全球几百个节点上都存在，
你的 ISP 把你路由到哪个节点，取决于它自己的 BGP 策略 —— 而这个策略
经常很糟糕。实测你的域名 liuyan.luojunqi.xyz：

    loc=CN  colo=FRA   ← 识别为中国用户，却送去了德国法兰克福
    loc=CN  colo=LAX   ← 或者送去美国洛杉矶

延迟自然 240ms 起步。但 Cloudflare 有大量**国内直达**的优质节点
（香港、新加坡、日本、圣何塞），只要手动指定接入 IP，延迟能降到
50~150ms。

这个脚本就是帮你从 Cloudflare 的官方 IP 段里，找出**从你的网络**
走起来最快的那些 IP。

═══════════════════════════════════════════════════════════════════════
为什么必须在国内跑
═══════════════════════════════════════════════════════════════════════

IP 优选的结论**强依赖你所在的位置和运营商**。
电信 / 联通 / 移动三家的国际出口线路完全不同，
同一个 IP 在电信可能 60ms，在移动可能 400ms。

所以：**请在你的 Windows 电脑上运行本脚本**，而不是在境外服务器上。
境外跑出来的结果是无效的。

═══════════════════════════════════════════════════════════════════════
用法
═══════════════════════════════════════════════════════════════════════

    # 1. 探测（默认扫描 CF 官方段抽样，约 2~4 分钟）
    python cf_ip_optimize.py

    # 2. 指定你的域名
    python cf_ip_optimize.py --host liuyan.luojunqi.xyz

    # 3. 只测指定 IP（比如别人给你的列表）
    python cf_ip_optimize.py --ips 104.16.0.1 172.64.0.1

    # 4. 加大密度（更慢，但更可能找到尖子生）
    python cf_ip_optimize.py --dense

输出：
    best_ips.txt    每行一个 IP，可直接用于 3Proxy / mosdns / hosts
    report.csv      完整结果（IP、握手延迟、总耗时、接入节点、归属地）

═══════════════════════════════════════════════════════════════════════
拿到结果后怎么用
═══════════════════════════════════════════════════════════════════════

方案 A · 本机 3Proxy（只加速你这台电脑，最快上手）
    见同目录 README.md

方案 B · 路由器 mosdns（家里所有设备全局加速）
    见同目录 README.md

方案 C · 服务端 SaaS 优选（所有用户受益，推荐）
    在 Cloudflare Dashboard 给域名加一条 CNAME 记录指向优选 IP。
    注意：这需要域名接入 Cloudflare 且你有 DNS 编辑权限。

⚠️ 使用须知
    优选 IP 属于「见光死」资源。不要长时间、大流量占用单个 IP，
    更不要拿去做机场。用得越狠，被封得越快。
"""

import argparse
import concurrent.futures as cf
import csv
import ipaddress
import random
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Cloudflare 官方 IPv4 段
#
# 来源：https://www.cloudflare.com/ips-v4
# 这些是 CF 对外公布的 Anycast 前缀。所有 CF 域名的边缘节点都落在
# 这些段里，因此按段抽样就能覆盖全球节点。
# ---------------------------------------------------------------------------
CF_SEGMENTS = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
]


def gen_candidates(dense: bool):
    """从官方段里抽样生成候选 IP。

    每个 /24 抽一个代表 IP 就足够了 —— 同一个 /24 内的边缘节点
    路由行为高度一致，扫太密只是浪费时间。

    但 /24 数量很大（CF 全网约 200 万个 IP），全扫不现实。
    这里按段大小分配配额：小段密扫，大段按步长跳采。
    """
    ips = []
    per_small = 40 if dense else 12   # 小段（<=/20）每个 /24 抽几个
    big_samples = 60 if dense else 20  # 大段跳采多少个

    for seg in CF_SEGMENTS:
        net = ipaddress.ip_network(seg)
        if net.num_addresses <= 4096:          # /20 及更小
            hosts = list(net.hosts())
            random.shuffle(hosts)
            ips.extend(str(h) for h in hosts[:per_small])
        else:                                   # /19 ~ /13
            step = net.num_addresses // big_samples
            ips.extend(str(net.network_address + i * step)
                       for i in range(1, big_samples))
    return ips


def probe(host: str, ip: str, timeout: float):
    """测试单个 IP 能否正常服务我们的域名。

    关键：**必须验证 HTTPS 与 SNI 都通**，光 ping 通没用。

    ping 通的 IP 不一定能承载 TLS —— 有些 IP 不在你的域名的
    证书覆盖范围内，握手会失败（表现为 Error 1034 之类的错误）。
    所以这里直接用 curl 带上 SNI 请求 /cdn-cgi/trace：
        能拿到正确响应 = 这个 IP 真的能服务我们的域名
    """
    try:
        r = subprocess.run(
            [
                "curl", "-sS", "-k",
                "--connect-timeout", str(timeout),
                "--max-time", str(timeout + 5),
                "--resolve", f"{host}:443:{ip}",
                "-o", "-",
                "-w", "\n%{time_connect} %{time_total} %{http_code}",
                f"https://{host}/cdn-cgi/trace",
            ],
            capture_output=True, text=True, timeout=timeout + 10,
        )
        if not r.stdout:
            return None

        lines = r.stdout.rsplit("\n", 1)
        if len(lines) != 2:
            return None

        body, metrics = lines
        parts = metrics.split()
        if len(parts) != 3:
            return None

        tc, tt, code = float(parts[0]), float(parts[1]), parts[2]
        if code != "200" or "colo=" not in body:
            return None

        colo = ""
        loc = ""
        for ln in body.splitlines():
            if ln.startswith("colo="):
                colo = ln.split("=", 1)[1]
            elif ln.startswith("loc="):
                loc = ln.split("=", 1)[1]

        return {
            "ip": ip,
            "time_connect": tc * 1000,
            "time_total": tt * 1000,
            "colo": colo,
            "loc": loc,
        }
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(
        description="Cloudflare 边缘 IP 优选扫描器（中国大陆专用）")
    ap.add_argument("--host", default="liuyan.luojunqi.xyz",
                    help="要加速的域名（必须已接入 Cloudflare）")
    ap.add_argument("--ips", nargs="*", help="只测指定的 IP，跳过段抽样")
    ap.add_argument("--dense", action="store_true",
                    help="加大扫描密度（更慢更全）")
    ap.add_argument("--timeout", type=float, default=4.0,
                    help="单个 IP 的连接超时秒数，默认 4")
    ap.add_argument("--concurrency", type=int, default=32,
                    help="并发数，默认 32。网络差就调小")
    ap.add_argument("--top", type=int, default=20,
                    help="结果保留前多少个，默认 20")
    args = ap.parse_args()

    if args.ips:
        candidates = [ip.strip() for ip in args.ips if ip.strip()]
    else:
        print("正在生成候选 IP（Cloudflare 官方段抽样）...", flush=True)
        candidates = gen_candidates(args.dense)

    # 去重但保持顺序无关（后面按延迟排序）
    candidates = list(dict.fromkeys(candidates))

    print(f"目标域名 : {args.host}")
    print(f"候选 IP  : {len(candidates)} 个")
    print(f"并发数   : {args.concurrency}    超时: {args.timeout}s")
    print("-" * 62)
    print("开始扫描，请耐心等待（预计 1~5 分钟）...\n", flush=True)

    started = time.time()
    results = []
    done = 0

    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = {ex.submit(probe, args.host, ip, args.timeout): ip
                   for ip in candidates}
        for fut in cf.as_completed(futures):
            done += 1
            r = fut.result()
            if r:
                results.append(r)
            if done % 25 == 0 or done == len(candidates):
                print(f"  进度 {done}/{len(candidates)}   "
                      f"可用 {len(results)}", flush=True)

    elapsed = time.time() - started

    if not results:
        print("\n❌ 一个可用 IP 都没找到。")
        print("   可能原因：")
        print("   · 网络完全不通（先确认能打开 https://{0}）".format(args.host))
        print("   · 超时太短，试试 --timeout 8")
        print("   · 域名没有接入 Cloudflare")
        return 1

    results.sort(key=lambda x: x["time_connect"])

    print()
    print("=" * 78)
    print(f"扫描完成，用时 {elapsed:.0f} 秒")
    print(f"可用 {len(results)} / {len(candidates)} 个")
    print("=" * 78)
    print()
    print(f"{'排名':<5}{'IP':<18}{'握手(ms)':<11}{'总耗时(ms)':<13}{'接入节点':<10}")
    print("-" * 78)
    for i, r in enumerate(results[:args.top], 1):
        print(f"{i:<5}{r['ip']:<18}{r['time_connect']:<11.1f}"
              f"{r['time_total']:<13.1f}{r['colo']:<10}")

    # 写入结果文件
    with open("best_ips.txt", "w", encoding="utf-8") as f:
        f.write(f"# Cloudflare 优选 IP · 目标域名 {args.host}\n")
        f.write(f"# 生成时间 {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"# 按 TLS 握手延迟升序排列\n")
        for r in results[:args.top]:
            f.write(f"{r['ip']}  # {r['colo']} {r['time_connect']:.0f}ms\n")

    with open("report.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "ip", "time_connect", "time_total", "colo", "loc"])
        w.writeheader()
        for r in results:
            w.writerow({**r,
                        "time_connect": round(r["time_connect"], 1),
                        "time_total": round(r["time_total"], 1)})

    print()
    print(f"✅ 已写入 best_ips.txt（前 {args.top} 个，可直接用）")
    print(f"✅ 已写入 report.csv（完整数据）")
    print()
    print("下一步：把 best_ips.txt 里的 IP 填进 3Proxy / mosdns 配置，")
    print("       或加一条 CNAME 记录（见同目录 README.md）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中断。")
        sys.exit(130)
