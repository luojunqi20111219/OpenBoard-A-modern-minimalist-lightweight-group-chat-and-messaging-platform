#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# Termux 一键部署 · Cloudflare 优选 IP 扫描
#
# 用法（在 Termux 里逐行粘贴）：
#   pkg update -y && pkg install -y curl python git
#   bash termux_setup.sh
#
# 或者更省事，直接把整个 cf-optimize 目录拷到手机存储再跑。
# ============================================================================
set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

say()  { printf "${CYAN}▸${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}✅${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠️ ${NC} %s\n" "$1"; }
die()  { printf "${RED}❌${NC} %s\n" "$1"; exit 1; }

echo
echo "════════════════════════════════════════════════"
echo "   Cloudflare 优选 IP · Termux 部署"
echo "════════════════════════════════════════════════"
echo

# ---------------------------------------------------------------------------
# 1. 确认在 Termux 里
# ---------------------------------------------------------------------------
if [ -z "$TERMUX_VERSION" ] && [ ! -d /data/data/com.termux ]; then
    warn "看起来不在 Termux 环境中（TERMUX_VERSION 未设置）"
    warn "如果你确实在 Termux 里，可以忽略这条继续"
fi

# ---------------------------------------------------------------------------
# 2. 检查依赖
# ---------------------------------------------------------------------------
say "检查依赖..."

command -v python >/dev/null 2>&1 || die "缺少 python。请先执行：pkg install -y python"
ok "python 已就绪（$(python --version 2>&1)）"

if ! command -v curl >/dev/null 2>&1; then
    warn "缺少 curl，正在安装..."
    pkg install -y curl || die "curl 安装失败，请手动执行：pkg install -y curl"
fi
ok "curl 已就绪"

# 验证 python 的 ipaddress 模块（Termux 的 python 通常自带，但保险起见查一下）
if ! python -c "import ipaddress, concurrent.futures, csv" 2>/dev/null; then
    die "python 缺少标准库模块，建议重装：pkg install -y python"
fi
ok "python 标准库完整"

# ---------------------------------------------------------------------------
# 3. 确认脚本存在
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

[ -f cf_ip_optimize.py ] || die "找不到 cf_ip_optimize.py，请确认本脚本和它放在同一目录"

# ---------------------------------------------------------------------------
# 4. 连通性预检
# ---------------------------------------------------------------------------
echo
say "预检网络连通性..."

TEST_HOST="liuyan.luojunqi.xyz"
if curl -sS -k --connect-timeout 8 --max-time 15 -o /dev/null \
     -w "" "https://$TEST_HOST/cdn-cgi/trace" 2>/dev/null; then
    ok "能连上 $TEST_HOST"
else
    warn "连不上 $TEST_HOST —— 可能网络不通，扫描结果会为空"
    warn "先确认手机能打开 https://$TEST_HOST"
fi

# 看看当前被分配到哪个节点（这个信息很有价值）
echo
say "当前接入节点（这是优化前的基线）..."
TRACE=$(curl -sS -k --connect-timeout 8 --max-time 15 \
        "https://$TEST_HOST/cdn-cgi/trace" 2>/dev/null || true)
if [ -n "$TRACE" ]; then
    COLO=$(echo "$TRACE" | grep '^colo=' | cut -d= -f2)
    LOC=$(echo "$TRACE" | grep '^loc=' | cut -d= -f2)
    IP=$(echo "$TRACE" | grep '^ip=' | cut -d= -f2)
    echo "   接入节点 colo : ${COLO:-未知}"
    echo "   识别地区 loc  : ${LOC:-未知}"
    echo "   当前出口 IP   : ${IP:-未知}"
    echo

    case "$COLO" in
        HKG|SIN|NRT|KIX|ICN|TPE)
            ok "当前已经是亚洲优质节点，优选空间可能不大"
            warn "但仍可尝试 —— 同一地区不同 IP 的延迟也能差出一倍"
            ;;
        LAX|SJC|SEA|PDX)
            warn "当前走的是美国西海岸，绕远了。优选应该能明显提速"
            ;;
        FRA|AMS|LHR|CDG)
            warn "当前走的是欧洲，绕了大半个地球。优选收益会非常大"
            ;;
        *)
            say "节点 $COLO —— 跑完扫描对比一下就知道有没有提升"
            ;;
    esac
else
    warn "拿不到节点信息（网络问题）"
fi

# ---------------------------------------------------------------------------
# 5. 跑扫描
# ---------------------------------------------------------------------------
echo
echo "════════════════════════════════════════════════"
say "开始扫描（预计 1~5 分钟，请保持屏幕常亮）"
echo "════════════════════════════════════════════════"
echo

# Termux 上并发别开太高 —— 手机 CPU 和网络都比电脑弱
# --timeout 4 是移动网络的合理值，再短会误杀正常 IP
python cf_ip_optimize.py \
    --host "$TEST_HOST" \
    --timeout 4 \
    --concurrency 24 \
    --top 20

echo
echo "════════════════════════════════════════════════"
ok "扫描完成"
echo "════════════════════════════════════════════════"
echo

# ---------------------------------------------------------------------------
# 6. 提示结果位置 + 怎么分享出来
# ---------------------------------------------------------------------------
echo "结果文件："
echo "   $SCRIPT_DIR/best_ips.txt    ← 前 20 个最优 IP"
echo "   $SCRIPT_DIR/report.csv      ← 完整数据（含 colo 节点信息）"
echo

# Android 11+ 的 Termux 访问共享存储需要 termux-setup-storage
if [ -d "$HOME/storage/downloads" ]; then
    cp -f best_ips.txt "$HOME/storage/downloads/" 2>/dev/null && \
        ok "已复制一份到手机「下载」目录：best_ips.txt" || true
    cp -f report.csv "$HOME/storage/downloads/" 2>/dev/null && \
        ok "已复制一份到手机「下载」目录：report.csv" || true
else
    warn "未配置存储权限，文件只在 Termux 内部。"
    warn "想导出到手机存储，先执行：termux-setup-storage"
    echo
    echo "  也可以直接把结果打印出来复制："
    echo "     cat $SCRIPT_DIR/report.csv"
fi

echo
echo "下一步："
echo "   把 report.csv 里的 colo 一列发我，我帮你判断线路质量，"
echo "   然后配置 SaaS 优选或 3Proxy。"
echo
