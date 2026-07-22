import datetime
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from werkzeug.security import generate_password_hash, check_password_hash
from app.config import Config
from app.database import get_db
from app.models import LoginData, RegisterData, PasswordChangeData, BlockUserData, UserProfileData, PushTokenData
from app.auth import create_access_token, get_current_user

router = APIRouter(prefix="/api")

def delete_user_and_data(db, user_id: int, username: str):
    db.execute("DELETE FROM messages WHERE name=?", (username,))
    groups = db.execute("SELECT id FROM groups WHERE owner_id=?", (user_id,)).fetchall()
    for g in groups:
        db.execute("DELETE FROM messages WHERE room_id=?", (g['id'],))
        db.execute("DELETE FROM groups WHERE id=?", (g['id'],))
    db.execute("DELETE FROM users WHERE id=?", (user_id,))

@router.post("/register")
async def register(data: RegisterData, response: Response, db = Depends(get_db)):
    if db.execute("SELECT id FROM users WHERE username=?", (data.username,)).fetchone():
        raise HTTPException(status_code=400, detail="用户名已被占用")
        
    hashed_pw = generate_password_hash(data.password)
    try:
        cursor = db.execute(
            "INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)",
            (data.username, hashed_pw, data.nickname or data.username)
        )
        user_id = cursor.lastrowid
        
        # Calculate default administrator role
        role = 1 if data.username in Config.ALLOWED_ADMINS else 0
        db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
        
        # Create JWT token
        token = create_access_token({"sub": str(user_id), "username": data.username, "role": role})
        
        # Legacy token column updates (ensure back-compat)
        db.execute("UPDATE users SET token=? WHERE id=?", (token, user_id))
        
        db.execute(
            "INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)",
            ("欢迎使用信语，开发人员：罗大帅", "系统", data.username)
        )
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"注册失败: {str(e)}")
        
    # Write to HTTP-only Cookie for seamless secure access to /admin
    response.set_cookie(key="token", value=token, httponly=True, max_age=3600*24*7, path="/")
    
    return {
        "code": 200,
        "token": token,
        "username": data.username,
        "nickname": data.nickname or data.username,
        "avatar": None,
        "id": user_id,
        "role": role
    }

@router.post("/login")
async def login(data: LoginData, response: Response, db = Depends(get_db)):
    user = db.execute("SELECT * FROM users WHERE username=?", (data.username,)).fetchone()
    if user and check_password_hash(user['password_hash'], data.password):
        if user['is_banned'] == 1:
            raise HTTPException(status_code=403, detail="您的账号已被管理员封禁")
            
        token = create_access_token({"sub": str(user['id']), "username": user['username'], "role": user['role']})
        
        db.execute("UPDATE users SET token=? WHERE id=?", (token, user['id']))
        db.commit()
        
        # Write to HTTP-only Cookie for seamless secure access to /admin
        response.set_cookie(key="token", value=token, httponly=True, max_age=3600*24*7, path="/")
        
        return {
            "code": 200,
            "token": token,
            "username": user['username'],
            "nickname": user['nickname'],
            "avatar": user['avatar'],
            "id": user['id'],
            "role": user['role']
        }
        
    raise HTTPException(status_code=401, detail="账号或密码错误")

@router.post("/logout")
async def logout(response: Response):
    # Clears secure cookie upon sign out
    response.delete_cookie(key="token", path="/")
    return {"status": "success", "msg": "已登出"}

@router.put("/user/password")
async def change_password(data: PasswordChangeData, current_user = Depends(get_current_user), db = Depends(get_db)):
    if not check_password_hash(current_user['password_hash'], data.old_password):
        raise HTTPException(status_code=400, detail="原密码错误")
        
    db.execute(
        "UPDATE users SET password_hash=? WHERE id=?", 
        (generate_password_hash(data.new_password), current_user['id'])
    )
    db.commit()
    return {"status": "success", "msg": "密码修改成功"}

@router.post("/user/block")
async def toggle_block_user(data: BlockUserData, current_user = Depends(get_current_user), db = Depends(get_db)):
    blocked_list = [u.strip() for u in (current_user['blocked_users'] or '').split(',') if u.strip()]
    
    if data.target_username in blocked_list:
        blocked_list.remove(data.target_username)
        msg = "已取消拉黑"
        is_blocked = False
    else:
        blocked_list.append(data.target_username)
        msg = "已拉黑"
        is_blocked = True
        
    db.execute("UPDATE users SET blocked_users=? WHERE id=?", (','.join(blocked_list), current_user['id']))
    db.commit()
    return {"status": "success", "msg": msg, "is_blocked": is_blocked}

@router.delete("/user/account")
async def delete_account(response: Response, current_user = Depends(get_current_user), db = Depends(get_db)):
    if current_user['username'] == "官方账号":
        raise HTTPException(status_code=403, detail="保护账号不可注销")
        
    delete_user_and_data(db, current_user['id'], current_user['username'])
    db.commit()
    
    response.delete_cookie(key="token", path="/")
    return {"status": "success", "msg": "账号已注销"}

@router.post("/user/profile")
async def update_profile(data: UserProfileData, current_user = Depends(get_current_user), db = Depends(get_db)):
    db.execute(
        "UPDATE users SET nickname=?, avatar=? WHERE id=?", 
        (data.nickname, data.avatar, current_user['id'])
    )
    db.commit()
    return {"status": "success"}

@router.get("/users")
async def get_users(current_user = Depends(get_current_user), db = Depends(get_db)):
    users = db.execute("SELECT username, nickname, avatar FROM users ORDER BY id DESC").fetchall()
    blocked_users = [u.strip() for u in (current_user['blocked_users'] or '').split(',') if u.strip()]
    return {"status": "success", "data": [dict(u) for u in users], "blocked_users": blocked_users}

@router.post("/user/push_token")
async def register_push_token(request: Request, data: PushTokenData, current_user = Depends(get_current_user), db = Depends(get_db)):
    token = request.headers.get("Authorization") or request.cookies.get("token")
    
    # 1. Record/update current device push token and login session token
    db.execute(
        "INSERT OR REPLACE INTO user_devices (user_id, device_id, push_token, token, last_login) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
        (current_user['id'], data.device_id, data.push_token, token)
    )
    db.commit()

    # 2. Query all registered devices for this user
    devices = db.execute(
        "SELECT id, device_id, push_token FROM user_devices WHERE user_id = ? ORDER BY last_login DESC",
        (current_user['id'],)
    ).fetchall()

    # If active devices exceed 2, kick out the oldest device(s)
    if len(devices) > 2:
        old_devices = devices[2:]
        for d in old_devices:
            # Send HMS force logout notification
            if d['push_token']:
                try:
                    from app.hms_push import send_hms_push
                    import asyncio
                    asyncio.create_task(send_hms_push(
                        [d['push_token']], 
                        "安全通知", 
                        "您的账号已在其他设备登录，当前设备已被下线。", 
                        0, 
                        "logout"
                    ))
                except Exception:
                    pass
            # Delete from database
            db.execute("DELETE FROM user_devices WHERE id = ?", (d['id'],))
        db.commit()

    # Backwards compatibility update on the main user record
    db.execute("UPDATE users SET push_token = ? WHERE id = ?", (data.push_token, current_user['id']))
    db.commit()

    return {"status": "success", "msg": "设备注册及华为推送 Token 已成功上报绑定"}


import uuid

@router.get("/qr/generate")
async def qr_generate(db = Depends(get_db)):
    qr_id = str(uuid.uuid4())
    db.execute("INSERT INTO qr_sessions (qr_id, status) VALUES (?, 'pending')", (qr_id,))
    db.commit()
    return {"code": 200, "qr_id": qr_id}

@router.get("/qr/status")
async def qr_status(qr_id: str, db = Depends(get_db)):
    session = db.execute("SELECT * FROM qr_sessions WHERE qr_id = ?", (qr_id,)).fetchone()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    response = {
        "status": session["status"],
        "token": session["token"]
    }
    
    if session["status"] == "authorized" and session["token"]:
        user = verify_token(session["token"], db)
        if user:
            response["user"] = {
                "id": user["id"],
                "username": user["username"],
                "nickname": user["nickname"],
                "avatar": user["avatar"],
                "role": user["role"]
            }
    return response

@router.post("/qr/scan")
async def qr_scan(data: dict, db = Depends(get_db)):
    qr_id = data.get("qr_id")
    session = db.execute("SELECT * FROM qr_sessions WHERE qr_id = ?", (qr_id,)).fetchone()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    db.execute("UPDATE qr_sessions SET status = 'scanned' WHERE qr_id = ?", (qr_id,))
    db.commit()
    return {"code": 200, "msg": "Scanned successfully"}

@router.post("/qr/authorize")
async def qr_authorize(request: Request, data: dict, current_user = Depends(get_current_user), db = Depends(get_db)):
    qr_id = data.get("qr_id")
    session = db.execute("SELECT * FROM qr_sessions WHERE qr_id = ?", (qr_id,)).fetchone()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    token = request.headers.get("Authorization") or request.cookies.get("token") or current_user.get("token")
    db.execute("UPDATE qr_sessions SET status = 'authorized', token = ? WHERE qr_id = ?", (token, qr_id))
    db.commit()
    return {"code": 200, "msg": "Authorized successfully"}


