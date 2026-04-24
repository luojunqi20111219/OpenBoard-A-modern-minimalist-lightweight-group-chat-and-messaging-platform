import os
import sqlite3
import secrets
from fastapi import FastAPI, Request, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List
from werkzeug.security import check_password_hash, generate_password_hash

app = FastAPI()
templates = Jinja2Templates(directory="templates")
DB_FILE = "board.db"

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

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
    cursor.execute("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, is_public INTEGER DEFAULT 1, owner_id INTEGER DEFAULT 0, avatar TEXT, is_frozen INTEGER DEFAULT 0)")
    cursor.execute("CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, sender TEXT)")
    
    columns_to_add = {
        "users": [("token", "TEXT"), ("role", "INTEGER DEFAULT 0"), ("is_banned", "INTEGER DEFAULT 0"), ("avatar", "TEXT"), ("blocked_users", "TEXT DEFAULT ''"), ("last_read_notice_id", "INTEGER DEFAULT 0")],
        "messages": [("room_id", "INTEGER DEFAULT 0"), ("reply", "TEXT"), ("receiver", "TEXT")],
        "groups": [("owner_id", "INTEGER DEFAULT 0"), ("avatar", "TEXT"), ("is_frozen", "INTEGER DEFAULT 0"),
                   ("view_mode", "INTEGER DEFAULT 0"), ("speak_mode", "INTEGER DEFAULT 0"),
                   ("black_view", "TEXT DEFAULT ''"), ("black_speak", "TEXT DEFAULT ''"),
                   ("white_view", "TEXT DEFAULT ''"), ("white_speak", "TEXT DEFAULT ''")]
    }
    for table, cols in columns_to_add.items():
        for col_name, col_type in cols:
            try: cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
            except: pass
            
    check_group = cursor.execute("SELECT * FROM groups WHERE id=0").fetchone()
    if not check_group:
        cursor.execute("INSERT OR REPLACE INTO groups (id, name, is_public, owner_id) VALUES (0, '公共大厅', 1, 0)")
        
    check_system = cursor.execute("SELECT * FROM users WHERE username='系统'").fetchone()
    if not check_system:
        cursor.execute("INSERT INTO users (username, nickname, role) VALUES ('系统', '系统通知', 1)")
        
    conn.commit()
    conn.close()

patch_db()

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

class BlockUserData(BaseModel):
    target_username: str

class GroupCreate(BaseModel):
    name: str
    is_public: int = 1

class GroupUpdate(BaseModel):
    name: str

class GroupPermissionUpdate(BaseModel):
    view_mode: int = 0
    speak_mode: int = 0
    black_view: str = ""
    black_speak: str = ""
    white_view: str = ""
    white_speak: str = ""

class GroupAvatarUpdate(BaseModel):
    avatar: str

class AdminAction(BaseModel):
    user_id: Optional[int] = None
    msg_id: Optional[int] = None
    msg_ids: Optional[List[int]] = None
    group_id: Optional[int] = None
    group_ids: Optional[List[int]] = None
    new_password: Optional[str] = None
    filename: Optional[str] = None
    code: Optional[str] = None
    avatar_base64: Optional[str] = None

def is_admin(request: Request, db) -> bool:
    token = request.headers.get("Authorization")
    if not token: return False
    user = db.execute("SELECT username FROM users WHERE token=?", (token,)).fetchone()
    if not user: return False
    return user['username'] in ALLOWED_ADMINS

def delete_user_and_data(db, user_id, username):
    db.execute("DELETE FROM messages WHERE name=?", (username,))
    groups = db.execute("SELECT id FROM groups WHERE owner_id=?", (user_id,)).fetchall()
    for g in groups:
        db.execute("DELETE FROM messages WHERE room_id=?", (g['id'],))
        db.execute("DELETE FROM groups WHERE id=?", (g['id'],))
    db.execute("DELETE FROM users WHERE id=?", (user_id,))

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    if os.path.exists("favicon.ico"):
        return FileResponse("favicon.ico")
    raise HTTPException(status_code=404)

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

@app.post("/api/register")
async def register(data: RegisterData):
    db = get_db()
    if db.execute("SELECT id FROM users WHERE username=?", (data.username,)).fetchone():
        db.close()
        raise HTTPException(status_code=400, detail="用户名已被占用")
    token = secrets.token_hex(16)
    hashed_pw = generate_password_hash(data.password)
    try:
        cursor = db.execute("INSERT INTO users (username, password_hash, nickname, token) VALUES (?, ?, ?, ?)", (data.username, hashed_pw, data.nickname or data.username, token))
        user_id = cursor.lastrowid
        db.execute("INSERT INTO messages (name, content, receiver) VALUES (?, ?, ?)", ("系统", "欢迎使用信语，开发人员：罗大帅", data.username))
        db.commit()
    except:
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

@app.put("/api/user/password")
async def change_password(data: PasswordChangeData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请登录")
    if not check_password_hash(user['password_hash'], data.old_password):
        raise HTTPException(status_code=400, detail="原密码错误")
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(data.new_password), user['id']))
    db.commit()
    return {"status": "success", "msg": "密码修改成功"}

@app.post("/api/user/block")
async def toggle_block_user(data: BlockUserData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: 
        db.close()
        raise HTTPException(status_code=403, detail="未登录")
    
    blocked_list = [u.strip() for u in (user['blocked_users'] or '').split(',') if u.strip()]
    if data.target_username in blocked_list:
        blocked_list.remove(data.target_username)
        msg = "已取消拉黑"
        is_blocked = False
    else:
        blocked_list.append(data.target_username)
        msg = "已拉黑"
        is_blocked = True
        
    db.execute("UPDATE users SET blocked_users=? WHERE id=?", (','.join(blocked_list), user['id']))
    db.commit()
    db.close()
    return {"status": "success", "msg": msg, "is_blocked": is_blocked}

@app.delete("/api/user/account")
async def delete_account(request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="未登录")
    if user['username'] in ["admin", "官方账号"]:
        raise HTTPException(status_code=403, detail="保护账号不可注销")
    delete_user_and_data(db, user['id'], user['username'])
    db.commit()
    return {"status": "success", "msg": "账号已注销"}

@app.post("/api/user/profile")
async def update_profile(data: UserProfileData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请登录")
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
    blocked_users = [u.strip() for u in (user['blocked_users'] or '').split(',') if u.strip()]
    return {"status": "success", "data": [dict(u) for u in users], "blocked_users": blocked_users}

@app.get("/api/groups")
async def get_groups(request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone() if token else None
    username = user['username'] if user else None
    
    groups = db.execute("SELECT * FROM groups").fetchall()
    result = []
    
    for g in groups:
        if g['id'] == 0:
            result.append(dict(g))
            continue
            
        can_view = True
        is_owner = username and g['owner_id'] == user['id']
        is_admin = user and user['role'] == 1
        
        if not is_owner and not is_admin:
            if g['view_mode'] == 1:
                w_list = [u.strip() for u in (g['white_view'] or '').split(',') if u.strip()]
                if not username or username not in w_list:
                    can_view = False
            else:
                b_list = [u.strip() for u in (g['black_view'] or '').split(',') if u.strip()]
                if username and username in b_list:
                    can_view = False
                    
        if can_view:
            result.append(dict(g))
            
    db.close()
    return {"status": "success", "data": result}

@app.post("/api/groups")
async def create_group(data: GroupCreate, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: raise HTTPException(status_code=403, detail="请登录")
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

@app.put("/api/groups/{group_id}/permissions")
async def update_group_permissions(group_id: int, data: GroupPermissionUpdate, request: Request):
    if group_id == 0: raise HTTPException(status_code=403, detail="公共大厅不可修改权限")
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or group['owner_id'] != user['id']: raise HTTPException(status_code=403, detail="仅群主可设置权限")
    
    db.execute("UPDATE groups SET view_mode=?, speak_mode=?, black_view=?, black_speak=?, white_view=?, white_speak=? WHERE id=?", 
               (data.view_mode, data.speak_mode, data.black_view, data.black_speak, data.white_view, data.white_speak, group_id))
    db.commit()
    return {"status": "success"}

@app.post("/api/groups/{group_id}/avatar")
async def update_group_avatar(group_id: int, data: GroupAvatarUpdate, request: Request):
    if group_id == 0: raise HTTPException(status_code=403, detail="不可修改")
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or (group['owner_id'] != user['id'] and user['role'] != 1): raise HTTPException(status_code=403, detail="无权")
    db.execute("UPDATE groups SET avatar=? WHERE id=?", (data.avatar, group_id))
    db.commit()
    return {"status": "success"}

@app.delete("/api/groups/{group_id}")
async def delete_group(group_id: int, request: Request):
    if group_id == 0: raise HTTPException(status_code=403, detail="不可解散")
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or (group['owner_id'] != user['id'] and user['role'] != 1): raise HTTPException(status_code=403, detail="无权")
    db.execute("DELETE FROM groups WHERE id=?", (group_id,))
    db.execute("DELETE FROM messages WHERE room_id=?", (group_id,))
    db.commit()
    return {"status": "success"}

@app.get("/api/messages")
async def get_messages(request: Request, room_id: int = 0, target_user: Optional[str] = None):
    db = get_db()
    token = request.headers.get("Authorization")
    me = db.execute("SELECT username, blocked_users FROM users WHERE token=?", (token,)).fetchone() if token else None
    blocked_list = [u.strip() for u in (me['blocked_users'] or '').split(',') if u.strip()] if me else []
    
    if target_user:
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
    return {"status": "success", "data": [dict(r) for r in rows if r['name'] not in blocked_list]}

@app.post("/api/messages")
async def post_message(data: MessageData, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: 
        db.close()
        raise HTTPException(status_code=403, detail="未登录")
    if user['is_banned']: 
        db.close()
        raise HTTPException(status_code=403, detail="已被禁言")
        
    if data.receiver:
        receiver_user = db.execute("SELECT blocked_users FROM users WHERE username=?", (data.receiver,)).fetchone()
        if receiver_user:
            receiver_blocked_list = [u.strip() for u in (receiver_user['blocked_users'] or '').split(',') if u.strip()]
            if user['username'] in receiver_blocked_list:
                db.close()
                raise HTTPException(status_code=403, detail="对方已将您拉黑，无法发送消息")

    if data.room_id > 0 and not data.receiver:
        group = db.execute("SELECT * FROM groups WHERE id=?", (data.room_id,)).fetchone()
        if group:
            if group['is_frozen']:
                db.close()
                raise HTTPException(status_code=403, detail="此群聊已被管理员冻结，全员禁言")
            if group['owner_id'] != user['id'] and user['role'] != 1:
                if group['speak_mode'] == 1:
                    w_list = [u.strip() for u in (group['white_speak'] or '').split(',') if u.strip()]
                    if user['username'] not in w_list:
                        db.close()
                        raise HTTPException(status_code=403, detail="您不在该群的发言白名单中")
                else:
                    b_list = [u.strip() for u in (group['black_speak'] or '').split(',') if u.strip()]
                    if user['username'] in b_list:
                        db.close()
                        raise HTTPException(status_code=403, detail="您已被群主禁言")
                        
    db.execute("INSERT INTO messages (name, content, room_id, receiver) VALUES (?, ?, ?, ?)", (user['username'], data.content, data.room_id, data.receiver))
    db.commit()
    db.close()
    return {"status": "success"}

@app.post("/api/admin/toggle_freeze_group")
async def admin_toggle_freeze_group(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    if data.group_id == 0: return {"status": "error", "msg": "公共大厅受保护"}
    group = db.execute("SELECT is_frozen FROM groups WHERE id=?", (data.group_id,)).fetchone()
    if not group: return {"status": "error"}
    new_status = 0 if group['is_frozen'] else 1
    db.execute("UPDATE groups SET is_frozen=? WHERE id=?", (new_status, data.group_id))
    db.commit()
    return {"status": "success", "msg": "已冻结" if new_status else "已解冻"}

@app.post("/api/admin/update_user_avatar")
async def admin_update_user_avatar(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    db.execute("UPDATE users SET avatar=? WHERE id=?", (data.avatar_base64, data.user_id))
    db.commit()
    return {"status": "success", "msg": "头像已强行修改"}

@app.post("/api/admin/update_group_avatar")
async def admin_update_group_avatar(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    db.execute("UPDATE groups SET avatar=? WHERE id=?", (data.avatar_base64, data.group_id))
    db.commit()
    return {"status": "success", "msg": "群头像已强行修改"}

@app.post("/api/admin/delete_user")
async def admin_delete_user(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    target = db.execute("SELECT * FROM users WHERE id=?", (data.user_id,)).fetchone()
    if not target or target['username'] in ["admin", "官方账号"]: return {"status": "error"}
    delete_user_and_data(db, target['id'], target['username'])
    db.commit()
    return {"status": "success"}

@app.post("/api/admin/reset_password")
async def admin_reset_password(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(data.new_password), data.user_id))
    db.commit()
    return {"status": "success"}

@app.post("/api/admin/delete_group")
async def admin_delete_group(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    db.execute("DELETE FROM groups WHERE id=?", (data.group_id,))
    db.execute("DELETE FROM messages WHERE room_id=?", (data.group_id,))
    db.commit()
    return {"status": "success"}

@app.post("/api/delete_messages")
async def delete_messages(data: AdminAction, request: Request):
    db = get_db()
    if not is_admin(request, db): return {"status": "error"}
    p = ', '.join(['?'] * len(data.msg_ids))
    db.execute(f"DELETE FROM messages WHERE id IN ({p})", data.msg_ids)
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
        return {"msg": "成功"}
    return {"msg": "失败"}

@app.post("/api/admin/broadcast")
async def admin_broadcast(data: MessageData, request: Request):
    db = get_db()
    if not is_admin(request, db): raise HTTPException(status_code=403, detail="无权操作")
    db.execute("INSERT INTO notifications (content, sender) VALUES (?, ?)", (data.content, "系统"))
    db.commit()
    db.close()
    return {"status": "success"}

@app.get("/api/notifications")
async def get_notifications(request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT last_read_notice_id FROM users WHERE token=?", (token,)).fetchone()
    if not user: 
        db.close()
        return {"status": "error", "data": []}
    
    notices = db.execute("SELECT * FROM notifications ORDER BY id DESC LIMIT 20").fetchall()
    last_read_id = user['last_read_notice_id']
    db.close()
    return {"status": "success", "data": [dict(n) for n in notices], "last_read_id": last_read_id}

@app.post("/api/notifications/read")
async def mark_notifications_read(request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT id FROM users WHERE token=?", (token,)).fetchone()
    if not user: 
        db.close()
        raise HTTPException(status_code=403)
    
    max_id_row = db.execute("SELECT MAX(id) as max_id FROM notifications").fetchone()
    max_id = max_id_row['max_id'] if max_id_row and max_id_row['max_id'] else 0
    db.execute("UPDATE users SET last_read_notice_id=? WHERE id=?", (max_id, user['id']))
    db.commit()
    db.close()
    return {"status": "success"}

@app.post("/api/upload")
async def upload_file(request: Request, file: UploadFile = File(...)):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    db.close()
    if not user: raise HTTPException(status_code=403, detail="未登录")
    
    ext = os.path.splitext(file.filename)[1]
    filename = f"{secrets.token_hex(8)}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    with open(filepath, "wb") as f:
        f.write(await file.read())
        
    return {
        "status": "success", 
        "url": f"/uploads/{filename}", 
        "filename": file.filename,
        "download_url": f"/api/download/{filename}"
    }

@app.get("/api/download/{filename}")
async def download_file(filename: str):
    filepath = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(filepath):
        return FileResponse(filepath, filename=filename)
    raise HTTPException(status_code=404, detail="文件不存在")

@app.delete("/api/messages/{msg_id}")
async def recall_message(msg_id: int, request: Request):
    token = request.headers.get("Authorization")
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if not user: 
        db.close()
        raise HTTPException(status_code=403, detail="未登录")
    
    msg = db.execute("SELECT *, (strftime('%s', 'now') - strftime('%s', created_at)) as age_seconds FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not msg:
        db.close()
        raise HTTPException(status_code=404, detail="消息不存在")
        
    if msg['name'] != user['username'] and user['role'] != 1:
        db.close()
        raise HTTPException(status_code=403, detail="无权撤回")
        
    if msg['age_seconds'] is not None and msg['age_seconds'] > 120 and user['role'] != 1:
        db.close()
        raise HTTPException(status_code=403, detail="只能撤回2分钟内的消息")
        
    db.execute("UPDATE messages SET content='[system_recalled]' WHERE id=?", (msg_id,))
    db.commit()
    db.close()
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=True)