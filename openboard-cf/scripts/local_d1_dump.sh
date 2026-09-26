#!/usr/bin/env bash
# 把 wrangler 本地 D1 状态导出成 SQL（用于验证迁移脚本，也方便丢进远端 D1）
set -euo pipefail

DB=$(find /workspace/openboard-cf/.wrangler/state/v3/d1/miniflare-D1DatabaseObject -name '*.sqlite' ! -name '*-shm' ! -name '*-wal' | head -1)
OUT=${1:-/root/.codebuddy/artifact/local_d1_dump.sql}

rm -f "$OUT"
python3 - "$DB" "$OUT" <<'PY'
import sqlite3, sys, os

src, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(f'file:{src}?mode=ro', uri=True)

tables = [r[0] for r in con.execute(
    "SELECT name FROM sqlite_master WHERE type='table' "
    "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")]

with open(out, 'w', encoding='utf-8') as f:
    f.write('PRAGMA foreign_keys=OFF;\n')
    for t in tables:
        ddl = con.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()[0]
        f.write(f'DROP TABLE IF EXISTS "{t}";\n{ddl};\n')
    for t in tables:
        cur = con.execute(f'SELECT * FROM "{t}"')
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        if not rows:
            continue
        collist = ','.join('"%s"' % c for c in cols)
        f.write(f'-- {t}: {len(rows)} rows\n')
        for row in rows:
            vals = []
            for v in row:
                if v is None:
                    vals.append('NULL')
                elif isinstance(v, (int, float)):
                    vals.append(str(v))
                else:
                    vals.append("'" + str(v).replace("'", "''") + "'")
            f.write(f'INSERT INTO "{t}" ({collist}) VALUES ({",".join(vals)});\n')
    f.write('PRAGMA foreign_keys=ON;\n')

print(f'导出 {len(tables)} 张表 -> {out} ({os.path.getsize(out)} bytes)')
PY
