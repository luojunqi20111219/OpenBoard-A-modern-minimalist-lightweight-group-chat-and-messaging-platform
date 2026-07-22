import asyncio
import datetime
import hmac
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from werkzeug.security import generate_password_hash, check_password_hash
from app.config import Config
from app.database import get_db
from app.models import (
    LoginData, RegisterData, PasswordChangeData, BlockUserData, UserProfileData,
    PushTokenData, WebDeviceData, DeviceLogoutData,
)
from app.auth import create_access_token, get_current_user, revoke_token, verify_token
from app.media import normalize_avatar
from app.websocket import manager

router = APIRouter(prefix="/api")

REMEMBER_SESSION_MINUTES = 60 * 24 * 30
BROWSER_SESSION_MINUTES = 60 * 12

def create_session_token(user_id: int, username: str, role: int, remember_me: bool) -> str:
    expires_minutes = REMEMBER_SESSION_MINUTES if remember_me else BROWSER_SESSION_MINUTES
    return create_access_token(
        {"sub": str(user_id), "username": username, "role": role},
        expires_minutes=expires_minutes,
    )

def set_session_cookie(response: Response, token: str, remember_me: bool) -> None:
    cookie_options = {
        "key": "token",
        "value": token,
        "httponly": True,
        "secure": True,
        "samesite": "lax",
        "path": "/",
    }
    if remember_me:
        cookie_options["max_age"] = REMEMBER_SESSION_MINUTES * 60
    response.set_cookie(**cookie_options)

def register_device_session(db, user_id: int, token: str, device_id: str, device_name: str, user_agent: str = "") -> None:
    device_id = (device_id or "").strip()[:128]
    if not device_id:
        return
    device_name = (device_name or "网页设备").strip()[:120]
    user_agent = (user_agent or "").strip()[:500]
    db.execute(
        """
        INSERT INTO user_devices (user_id, device_id, token, device_name, user_agent, last_login)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
            token=excluded.token,
            device_name=excluded.device_name,
            user_agent=excluded.user_agent,
            last_login=CURRENT_TIMESTAMP
        """,
        (user_id, device_id, token, device_name, user_agent),
    )

def delete_user_and_data(db, user_id: int, username: str):
    db.execute("DELETE FROM messages WHERE name=?", (username,))
    groups = db.execute("SELECT id FROM groups WHERE owner_id=?", (user_id,)).fetchall()
    for g in groups:
        db.execute("DELETE FROM messages WHERE room_id=?", (g['id'],))
        db.execute("DELETE FROM groups WHERE id=?", (g['id'],))
    db.execute("DELETE FROM users WHERE id=?", (user_id,))

@router.post("/register")
async def register(data: RegisterData, response: Response, request: Request, db = Depends(get_db)):
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
        token = create_session_token(user_id, data.username, role, data.remember_me)
        
        # Legacy token column updates (ensure back-compat)
        db.execute("UPDATE users SET token=? WHERE id=?", (token, user_id))
        register_device_session(
            db, user_id, token, data.device_id, data.device_name,
            request.headers.get("User-Agent", ""),
        )
        
        db.execute(
            "INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)",
            ("欢迎使用信语，开发人员：罗大帅", "系统", data.username)
        )
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"注册失败: {str(e)}")
        
    # Write to HTTP-only Cookie for seamless secure access to /admin
    set_session_cookie(response, token, data.remember_me)
    
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
async def login(data: LoginData, response: Response, request: Request, db = Depends(get_db)):
    user = db.execute("SELECT * FROM users WHERE username=?", (data.username,)).fetchone()
    if user and check_password_hash(user['password_hash'], data.password):
        if user['is_banned'] == 1:
            raise HTTPException(status_code=403, detail="您的账号已被管理员封禁")
            
        token = create_session_token(user['id'], user['username'], user['role'], data.remember_me)
        
        db.execute("UPDATE users SET token=? WHERE id=?", (token, user['id']))
        register_device_session(
            db, user['id'], token, data.device_id, data.device_name,
            request.headers.get("User-Agent", ""),
        )
        db.commit()
        
        # Write to HTTP-only Cookie for seamless secure access to /admin
        set_session_cookie(response, token, data.remember_me)
        
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
async def logout(request: Request, response: Response, db = Depends(get_db)):
    token = request.headers.get("Authorization") or request.cookies.get("token")
    user = verify_token(token, db) if token else None
    if user:
        device = db.execute(
            "SELECT device_id FROM user_devices WHERE user_id=? AND token=?",
            (user["id"], token),
        ).fetchone()
        device_id = device["device_id"] if device else "unknown"
        revoke_token(db, token, user["id"], device_id)
        db.execute("DELETE FROM user_devices WHERE user_id=? AND token=?", (user["id"], token))
        db.commit()
    # Clears secure cookie upon sign out
    response.delete_cookie(key="token", path="/")
    return {"status": "success", "msg": "已登出"}

@router.get("/session")
async def get_session(request: Request, current_user = Depends(get_current_user)):
    token = request.headers.get("Authorization") or request.cookies.get("token")
    return {
        "code": 200,
        "token": token,
        "username": current_user["username"],
        "nickname": current_user["nickname"],
        "avatar": current_user["avatar"],
        "id": current_user["id"],
        "role": current_user["role"],
    }

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
    try:
        avatar = normalize_avatar(data.avatar)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.execute(
        "UPDATE users SET nickname=?, avatar=? WHERE id=?", 
        (data.nickname, avatar, current_user['id'])
    )
    db.commit()
    return {"status": "success"}

@router.get("/users")
async def get_users(current_user = Depends(get_current_user), db = Depends(get_db)):
    users = db.execute("SELECT username, nickname, avatar FROM users ORDER BY id DESC").fetchall()
    blocked_users = [u.strip() for u in (current_user['blocked_users'] or '').split(',') if u.strip()]
    return {"status": "success", "data": [dict(u) for u in users], "blocked_users": blocked_users}

@router.get("/user/devices")
async def get_login_devices(request: Request, current_user = Depends(get_current_user), db = Depends(get_db)):
    current_token = request.headers.get("Authorization") or request.cookies.get("token") or ""
    rows = db.execute(
        """
        SELECT device_id, device_name, user_agent, push_token, token, last_login
        FROM user_devices
        WHERE user_id=?
        ORDER BY last_login DESC
        """,
        (current_user["id"],),
    ).fetchall()
    devices = []
    for row in rows:
        fallback_name = "Android 设备" if row["push_token"] else "网页设备"
        devices.append({
            "device_id": row["device_id"],
            "device_name": row["device_name"] or fallback_name,
            "last_login": row["last_login"],
            "is_current": bool(row["token"] and hmac.compare_digest(row["token"], current_token)),
        })
    return {"status": "success", "data": devices}

@router.post("/user/devices/register")
async def register_web_device(
    data: WebDeviceData,
    request: Request,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    token = request.headers.get("Authorization") or request.cookies.get("token")
    register_device_session(
        db, current_user["id"], token, data.device_id, data.device_name,
        request.headers.get("User-Agent", ""),
    )
    db.commit()
    return {"status": "success"}

@router.post("/user/devices/{device_id}/logout")
async def logout_device(
    device_id: str,
    data: DeviceLogoutData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None,
        check_password_hash,
        current_user["password_hash"],
        data.password,
    )
    if not password_matches:
        raise HTTPException(status_code=400, detail="密码错误")

    device = db.execute(
        """
        SELECT device_id, token, push_token
        FROM user_devices
        WHERE user_id=? AND device_id=?
        """,
        (current_user["id"], device_id),
    ).fetchone()
    if not device:
        raise HTTPException(status_code=404, detail="设备不存在或已退出")

    revoke_token(db, device["token"], current_user["id"], device["device_id"])
    db.execute(
        "DELETE FROM user_devices WHERE user_id=? AND device_id=?",
        (current_user["id"], device_id),
    )
    db.commit()

    if device["push_token"]:
        try:
            from app.hms_push import send_hms_push
            asyncio.create_task(send_hms_push(
                [device["push_token"]],
                "安全通知",
                "此设备已从登录设备管理中退出。",
                0,
                "logout",
            ))
        except Exception:
            pass

    await manager.close_user_connections(current_user["username"])
    return {"status": "success", "msg": "设备已退出登录"}

@router.post("/user/push_token")
async def register_push_token(request: Request, data: PushTokenData, current_user = Depends(get_current_user), db = Depends(get_db)):
    token = request.headers.get("Authorization") or request.cookies.get("token")
    
    # 1. Record/update current device push token and login session token
    db.execute(
        """
        INSERT INTO user_devices (user_id, device_id, push_token, token, device_name, user_agent, last_login)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
            push_token=excluded.push_token,
            token=excluded.token,
            device_name=COALESCE(excluded.device_name, user_devices.device_name),
            user_agent=excluded.user_agent,
            last_login=CURRENT_TIMESTAMP
        """,
        (
            current_user['id'], data.device_id, data.push_token, token,
            data.device_name or "Android 设备", request.headers.get("User-Agent", ""),
        )
    )
    db.commit()

    # 2. Query all registered devices for this user
    devices = db.execute(
        "SELECT id, device_id, push_token, token FROM user_devices WHERE user_id = ? ORDER BY last_login DESC",
        (current_user['id'],)
    ).fetchall()

    # Keep a reasonable ceiling while allowing users to manage several devices.
    if len(devices) > 10:
        old_devices = devices[10:]
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
            revoke_token(db, d['token'], current_user['id'], d['device_id'])
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
    # Long poll for up to 9 seconds so the browser avoids overlapping requests.
    for _ in range(30):
        session = db.execute("SELECT * FROM qr_sessions WHERE qr_id = ?", (qr_id,)).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if session["status"] != "pending":
            break
        await asyncio.sleep(0.3)
    
    response = {
        "status": session["status"],
        "token": session["token"]
    }
    
    if session["status"] == "authorized" and session["token"]:
        user = db.execute("SELECT id, username, nickname, avatar, role FROM users WHERE token = ?", (session["token"],)).fetchone()
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
        
    token = create_session_token(
        current_user["id"],
        current_user["username"],
        current_user["role"],
        remember_me=True,
    )
    db.execute("UPDATE users SET token = ? WHERE id = ?", (token, current_user["id"]))
    db.execute("UPDATE qr_sessions SET status = 'authorized', token = ? WHERE qr_id = ?", (token, qr_id))
    db.commit()
    return {"code": 200, "msg": "Authorized successfully"}
