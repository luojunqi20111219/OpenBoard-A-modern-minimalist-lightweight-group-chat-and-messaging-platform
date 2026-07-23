import sqlite3
from contextlib import contextmanager
from werkzeug.security import generate_password_hash
from app.config import Config

def get_db_connection():
    conn = sqlite3.connect(Config.DB_FILE, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn

# FastAPI Dependency
def get_db():
    conn = get_db_connection()
    try:
        yield conn
    finally:
        conn.close()

# Context Manager for non-HTTP scopes (like WebSockets or background tasks)
@contextmanager
def get_db_ctx():
    conn = get_db_connection()
    try:
        yield conn
    finally:
        conn.close()

def patch_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Core tables initialization
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            username TEXT UNIQUE, 
            password_hash TEXT, 
            nickname TEXT, 
            token TEXT, 
            role INTEGER DEFAULT 0, 
            is_banned INTEGER DEFAULT 0, 
            avatar TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT, 
            content TEXT, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, 
            room_id INTEGER DEFAULT 0, 
            reply TEXT, 
            receiver TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT, 
            is_public INTEGER DEFAULT 1, 
            owner_id INTEGER DEFAULT 0, 
            avatar TEXT, 
            is_frozen INTEGER DEFAULT 0
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            content TEXT, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, 
            sender TEXT, 
            target_user TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            msg_id INTEGER, 
            user TEXT, 
            emoji TEXT, 
            time TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS message_reads (
            msg_id INTEGER, 
            user TEXT, 
            read_at TEXT, 
            PRIMARY KEY (msg_id, user)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user_id INTEGER, 
            device_id TEXT, 
            push_token TEXT, 
            token TEXT, 
            last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, device_id)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS revoked_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER,
            device_id TEXT,
            revoked_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS favorite_emojis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            emoji TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, emoji)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS qr_sessions (
            qr_id TEXT PRIMARY KEY,
            token TEXT DEFAULT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user TEXT NOT NULL,
            to_user TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(from_user, to_user)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_a TEXT NOT NULL,
            user_b TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_a, user_b)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS message_edits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_id INTEGER NOT NULL,
            editor TEXT NOT NULL,
            old_content TEXT NOT NULL,
            edited_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS message_favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            msg_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, msg_id)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversation_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            conversation_key TEXT NOT NULL,
            is_pinned INTEGER DEFAULT 0,
            is_muted INTEGER DEFAULT 0,
            last_read_id INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, conversation_key)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS group_members (
            group_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            member_role TEXT DEFAULT 'member',
            muted_until DATETIME,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(group_id, username)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS group_join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, username)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS group_invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            inviter TEXT NOT NULL,
            invitee TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, invitee)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS group_audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            target TEXT,
            detail TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS login_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT NOT NULL,
            device_id TEXT,
            device_name TEXT,
            ip_address TEXT,
            country TEXT,
            user_agent TEXT,
            success INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Check & append missing columns to guarantee backwards compatibility
    columns_to_add = {
        "users": [
            ("token", "TEXT"), 
            ("role", "INTEGER DEFAULT 0"), 
            ("is_banned", "INTEGER DEFAULT 0"), 
            ("avatar", "TEXT"), 
            ("blocked_users", "TEXT DEFAULT ''"), 
            ("last_read_notice_id", "INTEGER DEFAULT 0"),
            ("push_token", "TEXT"),
            ("two_factor_secret", "TEXT"),
            ("two_factor_enabled", "INTEGER DEFAULT 0"),
            ("read_receipts_enabled", "INTEGER DEFAULT 1")
        ],
        "messages": [
            ("room_id", "INTEGER DEFAULT 0"), 
            ("reply", "TEXT"), 
            ("receiver", "TEXT"),
            ("edited_at", "DATETIME"),
            ("edit_count", "INTEGER DEFAULT 0"),
            ("client_id", "TEXT")
        ],
        "groups": [
            ("owner_id", "INTEGER DEFAULT 0"), 
            ("avatar", "TEXT"), 
            ("is_frozen", "INTEGER DEFAULT 0"),
            ("view_mode", "INTEGER DEFAULT 0"), 
            ("speak_mode", "INTEGER DEFAULT 0"),
            ("black_view", "TEXT DEFAULT ''"), 
            ("black_speak", "TEXT DEFAULT ''"),
            ("white_view", "TEXT DEFAULT ''"), 
            ("white_speak", "TEXT DEFAULT ''"),
            ("announcement", "TEXT DEFAULT ''"),
            ("member_only", "INTEGER DEFAULT 0"),
            ("join_approval", "INTEGER DEFAULT 0")
        ],
        "notifications": [
            ("target_user", "TEXT")
        ],
        "user_devices": [
            ("device_name", "TEXT"),
            ("user_agent", "TEXT"),
            ("ip_address", "TEXT"),
            ("country", "TEXT"),
            ("last_seen", "DATETIME")
        ]
    }
    
    for table, cols in columns_to_add.items():
        for col_name, col_type in cols:
            try:
                cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
            except sqlite3.OperationalError:
                # Column already exists, safe to ignore
                pass

    # v7.7 replaces the legacy user-id membership table with username-based
    # membership records. Migrate in place so existing groups keep their
    # approved members and pending applications.
    member_columns = {
        row[1] for row in cursor.execute("PRAGMA table_info(group_members)").fetchall()
    }
    if "username" not in member_columns and "user_id" in member_columns:
        cursor.execute("ALTER TABLE group_members RENAME TO group_members_legacy")
        cursor.execute("""
            CREATE TABLE group_members (
                group_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                member_role TEXT DEFAULT 'member',
                muted_until DATETIME,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(group_id, username)
            )
        """)
        cursor.execute("""
            INSERT OR IGNORE INTO group_members
                (group_id, username, member_role, joined_at)
            SELECT legacy.group_id,
                   users.username,
                   CASE WHEN groups.owner_id = legacy.user_id THEN 'owner' ELSE 'member' END,
                   legacy.joined_at
            FROM group_members_legacy AS legacy
            JOIN users ON users.id = legacy.user_id
            LEFT JOIN groups ON groups.id = legacy.group_id
            WHERE COALESCE(legacy.status, 'approved') = 'approved'
        """)
        cursor.execute("""
            INSERT OR IGNORE INTO group_join_requests
                (group_id, username, status, created_at, updated_at)
            SELECT legacy.group_id, users.username, 'pending',
                   legacy.joined_at, legacy.joined_at
            FROM group_members_legacy AS legacy
            JOIN users ON users.id = legacy.user_id
            WHERE legacy.status = 'pending'
        """)
        cursor.execute("DROP TABLE group_members_legacy")

    group_columns = {
        row[1] for row in cursor.execute("PRAGMA table_info(groups)").fetchall()
    }
    if "need_approval" in group_columns and "join_approval" in group_columns:
        cursor.execute("""
            UPDATE groups
            SET join_approval = need_approval
            WHERE COALESCE(join_approval, 0) = 0 AND COALESCE(need_approval, 0) = 1
        """)
            
    # Seed public lobby group if not present
    check_group = cursor.execute("SELECT * FROM groups WHERE id=0").fetchone()
    if not check_group:
        cursor.execute("INSERT OR REPLACE INTO groups (id, name, is_public, owner_id) VALUES (0, '公共大厅', 1, 0)")
        
    # Enforce role = 1 for all configured admins, and seed default admin (官方账号) if missing
    for admin_username in Config.ALLOWED_ADMINS:
        check_admin = cursor.execute("SELECT * FROM users WHERE username=?", (admin_username,)).fetchone()
        if not check_admin:
            if admin_username == "官方账号":
                hashed_pw = generate_password_hash("12345678")
                cursor.execute("""
                    INSERT INTO users (username, password_hash, nickname, role) 
                    VALUES (?, ?, ?, 1)
                """, ("官方账号", hashed_pw, "官方账号"))
        else:
            cursor.execute("UPDATE users SET role = 1 WHERE username = ?", (admin_username,))
        
    # Seed File Transfer Assistant virtual user if missing
    check_filehelper = cursor.execute("SELECT * FROM users WHERE username='filehelper'").fetchone()
    if not check_filehelper:
        cursor.execute("""
            INSERT INTO users (username, password_hash, nickname, role, avatar) 
            VALUES (?, ?, ?, 2, ?)
        """, ("filehelper", "system_account", "文件传输助手", "system_filehelper"))

    # Create performance optimization indexes
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_name ON messages(name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_room_receiver_id ON messages(room_id, receiver, id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_name_receiver_id ON messages(name, receiver, id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content)")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client ON messages(name, client_id) WHERE client_id IS NOT NULL")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_message_reads_msg ON message_reads(msg_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_message_favorites_user ON message_favorites(username, created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_conversation_settings_user ON conversation_settings(username, is_pinned DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(username, group_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_group_requests_group_status ON group_join_requests(group_id, status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_group_invites_user_status ON group_invites(invitee, status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_group_audit_group_id ON group_audit_logs(group_id, id DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id, id DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_friend_requests_users ON friend_requests(from_user, to_user)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_friends_users ON friends(user_a, user_b)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_user_devices_user_login ON user_devices(user_id, last_login DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_revoked_sessions_user ON revoked_sessions(user_id)")

    # Backfill group owners into the new membership model without changing the
    # visibility rules of existing groups.
    cursor.execute("""
        INSERT OR IGNORE INTO group_members (group_id, username, member_role)
        SELECT g.id, u.username, 'owner'
        FROM groups g JOIN users u ON g.owner_id = u.id
        WHERE g.id > 0
    """)

    conn.commit()
    conn.close()
