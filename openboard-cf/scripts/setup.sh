#!/usr/bin/env bash
#
# 一键初始化 Cloudflare 资源（D1 / R2 / KV），并把返回的 id 自动写回配置文件。
#
#   export CLOUDFLARE_API_TOKEN=xxx       # 需要 Workers + D1 + R2 + KV 编辑权限
#   bash scripts/setup.sh
#
# 幂等：已存在的资源会跳过创建，只补写 id。
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "❌ 未设置 CLOUDFLARE_API_TOKEN。"
  echo "   到 Cloudflare 控制台 → My Profile → API Tokens 创建一个带"
  echo "   Workers Scripts:Edit / D1:Edit / Workers R2 Storage:Edit / Workers KV Storage:Edit 的 token。"
  echo "   （或在交互终端里改用 npx wrangler login）"
  exit 1
fi

WRANGLER="npx wrangler"
D1_NAME="openboard-db"
R2_NAME="openboard-uploads"
KV_NAME="openboard-kv"

# wrangler 在缺权限/无网络时会把错误打到 stdout 且退出码仍为 0，
# 因此这里统一用「能否解析出合法 id」作为成功判据。
pick_id() {  # pick_id <json> <name> <field>
  python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1] or '[]')
except Exception:
    sys.exit(0)
name, field = sys.argv[2], sys.argv[3]
if isinstance(data, dict):
    data = data.get('result', data.get('namespaces', []))
for item in data if isinstance(data, list) else []:
    title = item.get('name') or item.get('title') or ''
    if title == name or title.startswith(name + '-'):
        print(item.get(field, ''))
        break
" "$1" "$2" "$3"
}

cloud_ok=0
if $WRANGLER whoami >/dev/null 2>&1; then cloud_ok=1; fi
if [[ $cloud_ok -eq 0 ]]; then
  echo "⚠️  无法连接 Cloudflare（token 无效 / 无网络 / 缺少权限）。"
  echo "   检查 CLOUDFLARE_API_TOKEN 是否正确，网络能否访问 api.cloudflare.com。"
  exit 1
fi
echo "    Cloudflare 连接正常"

echo "==> 1/3 创建 D1 数据库：$D1_NAME"
D1_ID=$(pick_id "$($WRANGLER d1 list --json 2>/dev/null || echo '[]')" "$D1_NAME" "uuid")

if [[ -z "$D1_ID" ]]; then
  OUT=$($WRANGLER d1 create "$D1_NAME" 2>&1 || true)
  echo "$OUT" | grep -vE '^\s*$' | head -5
  D1_ID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
else
  echo "    已存在，uuid=$D1_ID"
fi
[[ -n "$D1_ID" ]] || { echo "❌ 无法取得 D1 uuid，请检查 token 是否有 D1:Edit 权限"; exit 1; }

echo "==> 2/3 创建 R2 存储桶：$R2_NAME"
$WRANGLER r2 bucket create "$R2_NAME" 2>&1 | grep -viE "already exists|^\s*$" | head -3 || true
echo "    完成"

echo "==> 3/3 创建 KV 命名空间：$KV_NAME"
KV_ID=$(pick_id "$($WRANGLER kv namespace list --json 2>/dev/null || echo '[]')" "$KV_NAME" "id")

if [[ -z "$KV_ID" ]]; then
  OUT=$($WRANGLER kv namespace create "$KV_NAME" 2>&1 || true)
  echo "$OUT" | grep -vE '^\s*$' | head -5
  KV_ID=$(echo "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
else
  echo "    已存在，id=$KV_ID"
fi
[[ -n "$KV_ID" ]] || { echo "❌ 无法取得 KV id，请检查 token 是否有 Workers KV Storage:Edit 权限"; exit 1; }

echo "==> 写回配置文件"
python3 - "$D1_ID" "$KV_ID" <<'PY'
import re, sys, pathlib

d1_id, kv_id = sys.argv[1], sys.argv[2]
for name in ('wrangler.toml', 'wrangler.worker.toml'):
    p = pathlib.Path(name)
    if not p.exists():
        continue
    s = p.read_text(encoding='utf-8')
    s = re.sub(r'(database_id\s*=\s*")[^"]*(")', r'\g<1>' + d1_id + r'\g<2>', s)
    s = re.sub(r'(?m)^(\s*id\s*=\s*")[^"]*(")', lambda m: m.group(1) + kv_id + m.group(2), s, count=1)
    p.write_text(s, encoding='utf-8')
    print(f'    {name} 已更新')
PY

echo
echo "✅ 资源就绪"
echo "   D1  database_id = $D1_ID"
echo "   KV  namespace   = $KV_ID"
echo
echo "下一步："
echo "   bash scripts/deploy.sh"
