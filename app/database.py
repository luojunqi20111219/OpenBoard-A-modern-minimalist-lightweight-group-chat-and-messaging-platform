import sqlite3
from contextlib import contextmanager
from werkzeug.security import generate_password_hash
from app.config import Config

def get_db_connection():
    conn = sqlite3.connect(Config.DB_FILE, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
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
    
    # Check & append missing columns to guarantee backwards compatibility
    columns_to_add = {
        "users": [
            ("token", "TEXT"), 
            ("role", "INTEGER DEFAULT 0"), 
            ("is_banned", "INTEGER DEFAULT 0"), 
            ("avatar", "TEXT"), 
            ("blocked_users", "TEXT DEFAULT ''"), 
            ("last_read_notice_id", "INTEGER DEFAULT 0"),
            ("push_token", "TEXT")
        ],
        "messages": [
            ("room_id", "INTEGER DEFAULT 0"), 
            ("reply", "TEXT"), 
            ("receiver", "TEXT")
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
            ("white_speak", "TEXT DEFAULT ''")
        ],
        "notifications": [
            ("target_user", "TEXT")
        ]
    }
    
    for table, cols in columns_to_add.items():
        for col_name, col_type in cols:
            try:
                cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
            except sqlite3.OperationalError:
                # Column already exists, safe to ignore
                pass
            
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

    conn.commit()
    conn.close()
