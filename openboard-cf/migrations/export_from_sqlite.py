#!/usr/bin/env python3
"""
把原项目的 SQLite 数据库（board.db）导出成可导入 D1 的 SQL 文件。

用法：
    python3 migrations/export_from_sqlite.py /path/to/board.db

产出：
    migrations/d1_import.sql

然后：
    npx wrangler d1 execute openboard-db --file=./migrations/d1_import.sql

注意：
    D1 一次导入的 SQL 有体积限制，数据量很大时建议加 --chunk 分片：
    python3 migrations/export_from_sqlite.py board.db --chunk 500
"""
import argparse
import os
import sqlite3
import sys

# 需要迁移的表（顺序：先主表后从表）
TABLES = [
    'users', 'groups', 'messages', 'notifications', 'reactions',
    'message_reads', 'user_devices', 'revoked_sessions', 'favorite_emojis',
    'qr_sessions', 'friend_requests', 'friends', 'message_edits',
    'message_favorites', 'conversation_settings', 'group_members',
    'group_join_requests', 'group_invites', 'group_audit_logs', 'login_history',
]


def quote(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def esc_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('db', help='原项目 board.db 路径')
    parser.add_argument('--out', default='migrations/d1_import.sql')
    parser.add_argument('--chunk', type=int, default=0, help='每个文件多少条 INSERT，0 表示不分片')
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f'找不到数据库文件：{args.db}', file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    existing = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}

    statements = []
    scrypt_users = []

    for table in TABLES:
        if table not in existing:
            print(f'  跳过不存在的表：{table}')
            continue

        rows = conn.execute(f'SELECT * FROM {esc_ident(table)}').fetchall()
        if not rows:
            continue

        columns = list(rows[0].keys())
        cols_sql = ', '.join(esc_ident(c) for c in columns)

        for row in rows:
            values = ', '.join(quote(row[c]) for c in columns)
            statements.append(
                f'INSERT OR IGNORE INTO {esc_ident(table)} ({cols_sql}) VALUES ({values});')

            if table == 'users' and row['password_hash']:
                ph = str(row['password_hash'])
                if ph.startswith('scrypt'):
                    scrypt_users.append(row['username'])

        print(f'  {table}: {len(rows)} 行')

    conn.close()

    out_dir = os.path.dirname(args.out) or '.'
    os.makedirs(out_dir, exist_ok=True)

    if args.chunk and args.chunk > 0:
        total = 0
        for i in range(0, len(statements), args.chunk):
            idx = i // args.chunk + 1
            path = args.out.replace('.sql', f'_part{idx:03d}.sql')
            with open(path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(statements[i:i + args.chunk]))
            total += 1
            print(f'  写入 {path}')
        print(f'\n共生成 {total} 个分片，请依次执行：')
        for idx in range(1, total + 1):
            path = args.out.replace('.sql', f'_part{idx:03d}.sql')
            print(f'  npx wrangler d1 execute openboard-db --file=./{path}')
    else:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(statements))
        print(f'\n已写入 {args.out}（{len(statements)} 条语句）')
        print('导入命令：')
        print(f'  npx wrangler d1 execute openboard-db --file=./{args.out}')

    if scrypt_users:
        print('\n⚠️  以下用户使用 werkzeug 3.x 的 scrypt 哈希，')
        print('   Cloudflare Workers 的 Web Crypto 不支持 scrypt，无法直接验证。')
        print('   迁移后这些账号需要重置密码（管理员后台 → 改密码）：')
        for u in scrypt_users:
            print(f'     - {u}')


if __name__ == '__main__':
    main()
