#!/usr/bin/env bash
#
# 部署到 Cloudflare Workers（静态资源 + API + Durable Object 同一个 Worker）
#
#   export CLOUDFLARE_API_TOKEN=xxx
#   bash scripts/deploy.sh
#
# ---------------------------------------------------------------------------
# 与旧 Pages 方案的差别
# ---------------------------------------------------------------------------
# 旧方案要先部署独立的 ChatHub DO Worker、再 pages deploy，
# 且 Pages 无法回传 WebSocket 的 101 响应（error 1101），实时功能不可用。
#
# 现在 DO 与 Worker 同脚本，一条 `wrangler deploy` 全部搞定，
# 不存在跨服务边界，WebSocket 直通。
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

D1_NAME="openboard-db"

echo "==> 0/5 环境检查"
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || {
  echo "❌ 未设置 CLOUDFLARE_API_TOKEN"; exit 1; }

# D1 / KV 的 id 必须已回填，缺一个都会部署到错误资源
missing=""
grep -q "REPLACE_WITH_YOUR_KV_ID" wrangler.toml && missing="KV"
grep -q "REPLACE_WITH_YOUR_D1_ID" wrangler.toml && missing="${missing:+$missing 和 }D1"
[[ -z "$missing" ]] || {
  echo "❌ wrangler.toml 里 ${missing} 的 id 还是占位符，请先执行 bash scripts/setup.sh"; exit 1; }
echo "    OK"

echo "==> 1/5 生成 Cloudflare 绑定类型"
npx wrangler types 2>/dev/null || echo "    跳过（不影响部署）"

echo "==> 2/5 TypeScript 类型检查"
npx tsc --noEmit
echo "    OK"

echo "==> 3/5 初始化 D1 表结构（幂等，重复执行安全）"
npx wrangler d1 execute "$D1_NAME" --remote --file=./schema.sql 2>&1 | tail -3

echo "==> 4/5 部署 Worker（含 DO 与静态资源）"
npx wrangler deploy

echo "==> 5/5 提示"
cat <<'MSG'

✅ 部署完成

若这是首次部署，还需要做两件事：

1) 设置 JWT 密钥（务必做，否则用的是内置开发密钥，任何人都能伪造 token）
     npx wrangler secret put JWT_SECRET
   # 生成随机串： openssl rand -base64 48
   # 写入后无需重新部署，下次请求即生效
   # ⚠️ 不能在 wrangler.toml 的 [vars] 里也声明同名变量，
   #    否则会报 "Binding name 'JWT_SECRET' already in use [code: 10053]"

2) 把自己设为管理员
     注册一个账号 → 然后执行：
     npx wrangler d1 execute openboard-db --remote \
       --command "UPDATE users SET role=1 WHERE username='你的用户名'"
   # 也可以直接把用户名加进 wrangler.toml 的 ALLOWED_ADMINS（逗号分隔）

部署前想先本地验证一遍： npm run preflight
部署后建议跑一次生产环境端到端测试： npm run test:live <你的域名>

自定义域名（二选一，Token 需 Zone:Workers Routes:Edit）：
  · Worker 自定义域（Cloudflare 自动签发证书，推荐）
      curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/domains" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
        -d '{"zone_id":"<ZONE_ID>","hostname":"openboard.example.com","service":"openboard","environment":"production"}'
  · Zone 级 Worker Route（需域名已有 proxied DNS 记录）
      curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/workers/routes" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
        -d '{"pattern":"openboard.example.com/*","script":"openboard"}'
MSG
