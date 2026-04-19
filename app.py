import os
import sqlite3
import secrets
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from typing import Optional, List
from werkzeug.security import check_password_hash, generate_password_hash

app = FastAPI()
templates = Jinja2Templates(directory="templates")
DB_FILE = "board.db"

# ==========================================
# 🛡️ 管理员安全白名单
# ==========================================
ALLOWED_ADMINS = ["官方账号"]

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def patch_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, nickname TEXT, token TEXT, role INTEGER DEFAULT 0, is_banned INTEGER DEFAULT 0, avatar TEXT)")
    cursor.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, room_id INTEGER DEFAULT 0, reply TEXT, receiver TEXT)")
    cursor.execute("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, is_public INTEGER DEFAULT 1, owner_id INTEGER DEFAULT 0)")
    
    columns_to_add = {
        "users": [("token", "TEXT"), ("role", "INTEGER DEFAULT 0"), ("is_banned", "INTEGER DEFAULT 0"), ("avatar", "TEXT")],
        "messages": [("room_id", "INTEGER DEFAULT 0"), ("reply", "TEXT"), ("receiver", "TEXT")],
        "groups": [("owner_id", "INTEGER DEFAULT 0")]
    }
    for table, cols in columns_to_add.items():
        for col_name, col_type in cols:
            try: cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
            except: pass
            
    check_group = cursor.execute("SELECT * FROM groups WHERE id=0").fetchone()
    if not check_group:
        cursor.execute("INSERT OR REPLACE INTO groups (id, name, is_public, owner_id) VALUES (0, '公共大厅', 1, 0)")
        
    conn.commit()
    conn.close()

patch_db()

# --- 数据模型 ---
class LoginData(BaseModel):
    username: str
    password: str

class RegisterData(BaseModel):
    username: str
    password: str
    nickname: Optional[str] = None

class PasswordChangeData(BaseModel):
    old_password: str
    new_password: str

class MessageData(BaseModel):
    content: str
    room_id: int = 0
    receiver: Optional[str] = None

class UserProfileData(BaseModel):
    nickname: Optional[str] = None
    avatar: Optional[str] = None

class GroupCreate(BaseModel):
    name: str
    is_public: int = 1

class GroupUpdate(BaseModel):
    name: str

class AdminAction(BaseModel):
    user_id: Optional[int] = None
    msg_id: Optional[int] = None
    msg_ids: Optional[List[int]] = None
    group_id: Optional[int] = None
    group_ids: Optional[List[int]] = None
    new_password: Optional[str] = None # 用于后台重置密码
    filename: Optional[str] = None
    code: Optional[str] = None

# ==========================================
# 🔒 后端安全核心函数
# ==========================================
def is_admin(request: Request, db) -> bool:
    token = request.headers.get("Authorization")
    if not token: return False
    user = db.execute("SELECT username FROM users WHERE token=?", (token,)).fetchone()
    if not user: return False
    return user['username'] in ALLOWED_ADMINS

# 删除用户及其所有关联数据（消息、创建的群聊）的统一函数
def delete_user_and_data(db, user_id, username):
    db.execute("DELETE FROM messages WHERE name=?", (username,)) # 删消息
    groups = db.execute("SELECT id FROM groups WHERE owner_id=?", (user_id,)).fetchall()
    for g in groups:
        db.execute("DELETE FROM messages WHERE room_id=?", (g['id'],)) # 删该群内的消息
        db.execute("DELETE FROM groups WHERE id=?", (g['id'],)) # 删群
    db.execute("DELETE FROM users WHERE id=?", (user_id,)) # 删账号

# ==========================================
# 🌐 页面路由
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={"request": request})

@app.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    db = get_db()
    messages = db.execute("SELECT * FROM messages ORDER BY id DESC").fetchall()
    users = db.execute("SELECT * FROM users ORDER BY id DESC").fetchall()
    groups = db.execute("SELECT * FROM groups ORDER BY id DESC").fetchall()
    db.close()
    return templates.TemplateResponse(
        request=request, name="admin.html", context={"request": request, "messages": messages, "users": users, "groups": groups}
    )

# ==========================================
# 💬 用户账户与社交 API
# ==========================================
@app.post("/api/register")
async def register(data: RegisterData):
    db = get_db()
    if db.execute("SELECT id FROM users WHERE username=?", (data.username,)).fetchone():
        db.close()
        raise HTTPException(status_code=400, detail="用户名已被占用，换一个试试吧！")
    
    token = secrets.token_hex(16)
    hashed_pw = generate_password_hash(data.password)
    try:
        cursor = db.execute("INSERT INTO users (username, password_hash, nickname, token) VALUES (?, ?, ?, ?)", (data.username, hashed_pw, data.nickname or data.username, token))
        user_id = cursor.lastrowid
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail="注册失败")
    finally:
        db.close()
    return {"code": 200, "token": token, "username": data.username, "nickname": data.nickname or data.username, "avatar": None, "id": user_id, "role": 0}

@app.post("/api/login")
async def login(data: LoginData):
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE username=?", (data.username,)).fetchone()
    if user and check_password_hash(user['password_hash'], data.password):
        token = secrets.token_hex(16)
        db.execute("UPDATE users SET token=? WHERE id=?", (token, user['id']))
        db.commit()
        return {"code": 200, "token": token, "username": user['username'], "nickname": user['nickname'], "avatar": user['avatar'], "id": user['id'], "role": user['role']}
    raise HTTPException(status_code=401, detail="账号或密码错误")

# 【新增】修改密码接口
@app.put("/api/user/password")
async def change_password(data: PasswordChangeData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请先登录")
    
    if not check_password_hash(user['password_hash'], data.old_password):
        raise HTTPException(status_code=400, detail="原密码错误！")
        
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(data.new_password), user['id']))
    db.commit()
    return {"status": "success", "msg": "密码修改成功，请重新登录"}

# 【新增】注销删除账号接口
@app.delete("/api/user/account")
async def delete_account(request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="未登录")
    
    if user['username'] in ["admin", "官方账号"]:
        raise HTTPException(status_code=403, detail="系统保护账号不可注销")

    delete_user_and_data(db, user['id'], user['username'])
    db.commit()
    return {"status": "success", "msg": "账号已彻底注销"}

@app.post("/api/user/profile")
async def update_profile(data: UserProfileData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请先登录")
    db.execute("UPDATE users SET nickname=?, avatar=? WHERE id=?", (data.nickname, data.avatar, user['id']))
    db.commit()
    return {"status": "success"}

@app.get("/api/users")
async def get_users(request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: return {"status": "error", "msg": "未登录"}
    users = db.execute("SELECT username, nickname, avatar FROM users ORDER BY id DESC").fetchall()
    return {"status": "success", "data": [dict(u) for u in users]}

@app.get("/api/groups")
async def get_groups():
    db = get_db()
    groups = db.execute("SELECT id, name, owner_id FROM groups WHERE is_public = 1").fetchall()
    return {"status": "success", "data": [dict(g) for g in groups]}

@app.post("/api/groups")
async def create_group(data: GroupCreate, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请先登录")
    cursor = db.execute("INSERT INTO groups (name, is_public, owner_id) VALUES (?, ?, ?)", (data.name, data.is_public, user['id']))
    db.commit()
    return {"status": "success", "group_id": cursor.lastrowid}

@app.put("/api/groups/{group_id}")
async def update_group(group_id: int, data: GroupUpdate, request: Request):
    if group_id == 0: raise HTTPException(status_code=403, detail="公共大厅不可修改")
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or (group['owner_id'] != user['id'] and user['role'] != 1): raise HTTPException(status_code=403, detail="无权操作")
    db.execute("UPDATE groups SET name=? WHERE id=?", (data.name, group_id))
    db.commit()
    return {"status": "success"}

@app.delete("/api/groups/{group_id}")
async def delete_group(group_id: int, request: Request):
    if group_id == 0: raise HTTPException(status_code=403, detail="公共大厅不可解散")
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or (group['owner_id'] != user['id'] and user['role'] != 1): raise HTTPException(status_code=403, detail="无权操作")
    db.execute("DELETE FROM groups WHERE id=?", (group_id,))
    db.execute("DELETE FROM messages WHERE room_id=?", (group_id,))
    db.commit()
    return {"status": "success"}

@app.get("/api/messages")
async def get_messages(request: Request, room_id: int = 0, target_user: Optional[str] = None):
    db = get_db()
    if target_user:
        token = request.headers.get("Authorization")
        me = db.execute("SELECT username FROM users WHERE token=?", (token,)).fetchone()
        if not me: return {"status": "error", "data": []}
        my_name = me['username']
        rows = db.execute("""
            SELECT m.id, m.content, m.created_at as time, u.nickname, u.username as name, u.avatar
            FROM messages m LEFT JOIN users u ON m.name = u.username 
            WHERE (m.name = ? AND m.receiver = ?) OR (m.name = ? AND m.receiver = ?) ORDER BY m.id ASC LIMIT 100
        """, (my_name, target_user, target_user, my_name)).fetchall()
    else:
        rows = db.execute("""
            SELECT m.id, m.content, m.created_at as time, u.nickname, u.username as name, u.avatar
            FROM messages m LEFT JOIN users u ON m.name = u.username 
            WHERE m.room_id = ? AND m.receiver IS NULL ORDER BY m.id ASC LIMIT 100
        """, (room_id,)).fetchall()
    return {"status": "success", "data": [dict(r) for r in rows]}

@app.post("/api/messages")
async def post_message(data: MessageData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请先登录")
    if user['is_banned']: raise HTTPException(status_code=403, detail="已被禁言")
    db.execute("INSERT INTO messages (name, content, room_id, receiver) VALUES (?, ?, ?, ?)", (user['username'], data.content, data.room_id, data.receiver))
    db.commit()
    return {"status": "success"}

# ==========================================
# 🛡️ 管理后台专用 API
# ==========================================

# 【新增】后台：强制删除用户
@app.post("/api/admin/delete_user")
async def admin_delete_user(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error", "msg": "拦截：非白名单管理员"}
    
    target = db.execute("SELECT * FROM users WHERE id=?", (data.user_id,)).fetchone()
    if not target: return {"status": "error", "msg": "用户不存在"}
    if target['username'] in ["admin", "官方账号"]: return {"status": "error", "msg": "系统内置账号受到终极保护，不可被删除"}
    
    delete_user_and_data(db, target['id'], target['username'])
    db.commit()
    return {"status": "success", "msg": f"已强制注销用户 {target['username']} 并清空其所有数据"}

# 【新增】后台：强制重置用户密码
@app.post("/api/admin/reset_password")
async def admin_reset_password(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error", "msg": "拦截：非白名单管理员"}
    if not data.new_password: return {"status": "error", "msg": "未提供新密码"}
    
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(data.new_password), data.user_id))
    db.commit()
    return {"status": "success", "msg": "密码已被强制重置"}

@app.post("/api/admin/delete_group")
async def admin_delete_group(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error", "msg": "安全拦截"}
    if data.group_id == 0: return {"status": "error", "msg": "公共大厅受保护"}
    db.execute("DELETE FROM groups WHERE id=?", (data.group_id,))
    db.execute("DELETE FROM messages WHERE room_id=?", (data.group_id,))
    db.commit()
    return {"status": "success", "msg": "群聊销毁成功"}

@app.post("/api/admin/delete_groups")
async def admin_delete_groups(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    safe_group_ids = [gid for gid in data.group_ids if gid != 0]
    if not safe_group_ids: return {"status": "error", "msg": "全为受保护群聊"}
    placeholders = ', '.join(['?'] * len(safe_group_ids))
    db.execute(f"DELETE FROM groups WHERE id IN ({placeholders})", safe_group_ids)
    db.execute(f"DELETE FROM messages WHERE room_id IN ({placeholders})", safe_group_ids)
    db.commit()
    return {"status": "success", "msg": "批量销毁成功"}

@app.post("/api/delete_messages")
async def delete_messages(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    placeholders = ', '.join(['?'] * len(data.msg_ids))
    db.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", data.msg_ids)
    db.commit()
    return {"status": "success"}

@app.post("/api/toggle_ban_user")
async def toggle_ban(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    user = db.execute("SELECT is_banned FROM users WHERE id=?", (data.user_id,)).fetchone()
    if user:
        db.execute("UPDATE users SET is_banned=? WHERE id=?", (0 if user['is_banned'] else 1, data.user_id))
        db.commit()
        return {"msg": "操作成功"}
    return {"msg": "用户不存在"}

@app.get("/api/list_templates")
async def list_templates(request: Request): 
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    return {"files": [f for f in os.listdir("templates") if f.endswith(".html")]}

@app.post("/api/get_template")
async def get_template(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    with open(os.path.join("templates", data.filename), "r", encoding="utf-8") as f: return {"code": f.read()}

@app.post("/api/save_template")
async def save_template(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    with open(os.path.join("templates", data.filename), "w", encoding="utf-8") as f: f.write(data.code)
    return {"msg": "保存成功"}

@app.get("/api/get_backend")
async def get_backend(request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    with open("app.py", "r", encoding="utf-8") as f: return {"code": f.read()}

@app.post("/api/apply_changes")
async def apply_changes(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    with open("app.py", "w", encoding="utf-8") as f: f.write(data.code)
    return {"msg": "代码已更新，重启中..."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)