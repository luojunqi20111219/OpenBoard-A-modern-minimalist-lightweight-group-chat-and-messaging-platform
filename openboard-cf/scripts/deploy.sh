#!/usr/bin/env bash
#
# 部署到 Cloudflare（Pages + 独立 Durable Object Worker）
#
#   export CLOUDFLARE_API_TOKEN=xxx
#   bash scripts/deploy.sh
#
# 顺序不能颠倒：Pages 引用的 ChatHub DO 必须先存在于线上，
# 否则 Pages 发布会报 "not exported in your entrypoint file"。
set -euo pipefail

cd "$(dirname "$0")/.."

D1_NAME="openboard-db"
DO_WORKER="openboard-chat-hub"

echo "==> 0/6 环境检查"
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || {
  echo "❌ 未设置 CLOUDFLARE_API_TOKEN（或在交互终端改用 npx wrangler login）"; exit 1; }
# 两个 id 都必须已回填，缺一个都会部署失败或连到错误资源
missing=""
grep -q "REPLACE_WITH_YOUR_KV_ID" wrangler.toml && missing="KV"
grep -q "REPLACE_WITH_YOUR_D1_ID" wrangler.toml && missing="${missing:+$missing 和 }D1"
[[ -z "$missing" ]] || {
  echo "❌ wrangler.toml 里 ${missing} 的 id 还是占位符，请先执行 bash scripts/setup.sh"; exit 1; }
echo "    OK"

echo "==> 1/6 生成 Cloudflare 绑定类型"
npx wrangler types 2>/dev/null || echo "    跳过（不影响部署）"

echo "==> 2/6 TypeScript 类型检查"
npx tsc --noEmit
echo "    OK"

echo "==> 3/6 初始化 D1 表结构（幂等，重复执行安全）"
npx wrangler d1 execute "$D1_NAME" --remote --file=./schema.sql 2>&1 | tail -3

echo "==> 4/6 部署 ChatHub Durable Object Worker"
npx wrangler deploy --config wrangler.do.toml

echo "==> 5/6 部署 Pages（前端 + API）"
npx wrangler pages deploy public --commit-dirty=true

echo "==> 6/6 提示"
cat <<'MSG'

✅ 部署完成

若这是首次部署，还需要做两件事：

1) 设置 JWT 密钥（务必做，否则用的是内置开发密钥）
     npx wrangler pages secret put JWT_SECRET
   # 生成随机串： openssl rand -base64 48
   # 设置后需重新执行一次 npx wrangler pages deploy public 才会生效

2) 把自己设为管理员
     注册一个账号 → 然后执行：
     npx wrangler d1 execute openboard-db --remote \
       --command "UPDATE users SET role=1 WHERE username='你的用户名'"
   # 也可以直接把用户名加进 wrangler.toml 的 ALLOWED_ADMINS（逗号分隔）

部署前想先本地验证一遍： npm run preflight
MSG
