import asyncio
import datetime
import hmac
import urllib.parse
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from werkzeug.security import generate_password_hash, check_password_hash
from app.config import Config
from app.database import get_db
from app.models import (
    LoginData, RegisterData, PasswordChangeData, BlockUserData, UserProfileData,
    PushTokenData, WebDeviceData, DeviceLogoutData, SecurityPreferencesData,
    TwoFactorConfirmData, TwoFactorDisableData, LogoutAllData,
)
from app.auth import create_access_token, get_current_user, revoke_token, verify_token
from app.media import normalize_avatar
from app.security import (
    client_ip, generate_totp_secret, login_ip_rate_limiter, login_rate_limiter,
    sanitize_plain_text, verify_totp,
)
from app.websocket import manager

router = APIRouter(prefix="/api")

REMEMBER_SESSION_MINUTES = 60 * 24 * 30
BROWSER_SESSION_MINUTES = 60 * 12
DUMMY_PASSWORD_HASH = generate_password_hash("openboard-invalid-password")

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

def register_device_session(
    db, user_id: int, token: str, device_id: str, device_name: str,
    user_agent: str = "", ip_address: str = "", country: str = "",
) -> bool:
    device_id = (device_id or "").strip()[:128]
    if not device_id:
        return False
    device_name = (device_name or "网页设备").strip()[:120]
    user_agent = (user_agent or "").strip()[:500]
    existed = db.execute(
        "SELECT 1 FROM user_devices WHERE user_id=? AND device_id=?", (user_id, device_id)
    ).fetchone()
    db.execute(
        """
        INSERT INTO user_devices (
            user_id, device_id, token, device_name, user_agent, ip_address, country, last_login, last_seen
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
            token=excluded.token,
            device_name=excluded.device_name,
            user_agent=excluded.user_agent,
            ip_address=excluded.ip_address,
            country=excluded.country,
            last_login=CURRENT_TIMESTAMP,
            last_seen=CURRENT_TIMESTAMP
        """,
        (user_id, device_id, token, device_name, user_agent, ip_address[:64], country[:16]),
    )
    return not bool(existed)


def record_login_history(db, user, data, request, success):
    ip_address = client_ip(request)
    country = (request.headers.get("CF-IPCountry") or request.headers.get("X-Country-Code") or "").upper()[:16]
    db.execute(
        """
        INSERT INTO login_history (
            user_id, username, device_id, device_name, ip_address, country, user_agent, success
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user['id'] if user else None, data.username, data.device_id, data.device_name,
            ip_address, country, request.headers.get("User-Agent", "")[:500], int(success),
        ),
    )
    return ip_address, country

def delete_user_and_data(db, user_id: int, username: str):
    db.execute("DELETE FROM messages WHERE name=?", (username,))
    groups = db.execute("SELECT id FROM groups WHERE owner_id=?", (user_id,)).fetchall()
    for g in groups:
        db.execute("DELETE FROM messages WHERE room_id=?", (g['id'],))
        db.execute("DELETE FROM groups WHERE id=?", (g['id'],))
    db.execute("DELETE FROM user_devices WHERE user_id=?", (user_id,))
    db.execute("DELETE FROM revoked_sessions WHERE user_id=?", (user_id,))
    db.execute("DELETE FROM friends WHERE user_a=? OR user_b=?", (username, username))
    db.execute("DELETE FROM friend_requests WHERE from_user=? OR to_user=?", (username, username))
    db.execute("DELETE FROM favorite_emojis WHERE username=?", (username,))
    db.execute("DELETE FROM message_favorites WHERE username=?", (username,))
    db.execute("DELETE FROM conversation_settings WHERE username=?", (username,))
    db.execute("DELETE FROM message_reads WHERE user=?", (username,))
    db.execute("DELETE FROM group_members WHERE username=?", (username,))
    db.execute("DELETE FROM group_join_requests WHERE username=?", (username,))
    db.execute("DELETE FROM group_invites WHERE inviter=? OR invitee=?", (username, username))
    db.execute("DELETE FROM login_history WHERE user_id=?", (user_id,))
    db.execute("DELETE FROM notifications WHERE target_user=?", (username,))
    db.execute("DELETE FROM users WHERE id=?", (user_id,))

@router.post("/register")
async def register(data: RegisterData, response: Response, request: Request, db = Depends(get_db)):
    if db.execute("SELECT id FROM users WHERE username=?", (data.username,)).fetchone():
        raise HTTPException(status_code=400, detail="用户名已被占用")
        
    hashed_pw = generate_password_hash(data.password)
    safe_nickname = sanitize_plain_text(data.nickname or data.username, 64) or data.username
    try:
        cursor = db.execute(
            "INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)",
            (data.username, hashed_pw, safe_nickname)
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
            client_ip(request),
            (request.headers.get("CF-IPCountry") or "")[:16],
        )
        record_login_history(db, {"id": user_id}, data, request, True)
        
        db.execute(
            "INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)",
            ("欢迎使用信语，开发人员：罗大帅", "系统", data.username)
        )
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="注册失败，请稍后重试")
        
    # Write to HTTP-only Cookie for seamless secure access to /admin
    set_session_cookie(response, token, data.remember_me)
    
    return {
        "code": 200,
        "token": token,
        "username": data.username,
        "nickname": safe_nickname,
        "avatar": None,
        "id": user_id,
        "role": role
    }

@router.post("/login")
async def login(data: LoginData, response: Response, request: Request, db = Depends(get_db)):
    account_key = data.username.strip().lower()
    ip_key = client_ip(request)
    retry_after = max(
        login_rate_limiter.retry_after(account_key),
        login_ip_rate_limiter.retry_after(ip_key),
    )
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="登录尝试过多，请稍后再试",
            headers={"Retry-After": str(retry_after)},
        )

    user = db.execute("SELECT * FROM users WHERE username=?", (data.username,)).fetchone()
    password_hash = user['password_hash'] if user else DUMMY_PASSWORD_HASH
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None, check_password_hash, password_hash, data.password
    )
    if user and password_matches:
        if user['is_banned'] == 1:
            raise HTTPException(status_code=403, detail="您的账号已被管理员封禁")

        if user['two_factor_enabled'] and not verify_totp(user['two_factor_secret'], data.otp or ""):
            record_login_history(db, user, data, request, False)
            db.commit()
            login_rate_limiter.record_failure(account_key)
            raise HTTPException(
                status_code=401,
                detail="需要有效的两步验证动态码",
                headers={"X-OpenBoard-2FA": "required"},
            )

        login_rate_limiter.reset(account_key)
        had_successful_login = db.execute(
            "SELECT 1 FROM login_history WHERE user_id=? AND success=1 LIMIT 1", (user['id'],)
        ).fetchone()
        ip_address = client_ip(request)
        country = (request.headers.get("CF-IPCountry") or request.headers.get("X-Country-Code") or "").upper()[:16]
        known_country = bool(country and db.execute(
            "SELECT 1 FROM login_history WHERE user_id=? AND success=1 AND country=? LIMIT 1",
            (user['id'], country),
        ).fetchone())

        token = create_session_token(user['id'], user['username'], user['role'], data.remember_me)

        db.execute("UPDATE users SET token=? WHERE id=?", (token, user['id']))
        new_device = register_device_session(
            db, user['id'], token, data.device_id, data.device_name,
            request.headers.get("User-Agent", ""),
            ip_address, country,
        )
        record_login_history(db, user, data, request, True)
        if had_successful_login and (new_device or (country and not known_country)):
            location = f"，地区 {country}" if country else ""
            db.execute(
                "INSERT INTO notifications (content, sender, target_user) VALUES (?, '安全中心', ?)",
                (
                    f"检测到新设备或新地区登录：{data.device_name or '未知设备'}，IP {ip_address}{location}",
                    user['username'],
                ),
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
            "role": user['role'],
            "two_factor_enabled": bool(user['two_factor_enabled']),
        }

    record_login_history(db, user, data, request, False)
    db.commit()
    lock_seconds = max(
        login_rate_limiter.record_failure(account_key),
        login_ip_rate_limiter.record_failure(ip_key),
    )
    if lock_seconds:
        raise HTTPException(
            status_code=429,
            detail="登录尝试过多，请稍后再试",
            headers={"Retry-After": str(lock_seconds)},
        )
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
async def get_session(request: Request, response: Response, current_user = Depends(get_current_user)):
    token = request.headers.get("Authorization") or request.cookies.get("token")
    if token and not request.cookies.get("token"):
        set_session_cookie(response, token, remember_me=True)
    return {
        "code": 200,
        "token": token,
        "username": current_user["username"],
        "nickname": current_user["nickname"],
        "avatar": current_user["avatar"],
        "id": current_user["id"],
        "role": current_user["role"],
        "two_factor_enabled": bool(current_user.get("two_factor_enabled", 0)),
        "read_receipts_enabled": bool(current_user.get("read_receipts_enabled", 1)),
    }

@router.put("/user/password")
async def change_password(data: PasswordChangeData, request: Request, current_user = Depends(get_current_user), db = Depends(get_db)):
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None, check_password_hash, current_user['password_hash'], data.old_password
    )
    if not password_matches:
        raise HTTPException(status_code=400, detail="原密码错误")
        
    current_token = request.headers.get("Authorization") or request.cookies.get("token") or ""
    other_sessions = db.execute(
        "SELECT device_id, token FROM user_devices WHERE user_id=? AND token IS NOT NULL AND token!=?",
        (current_user['id'], current_token),
    ).fetchall()
    for session in other_sessions:
        revoke_token(db, session['token'], current_user['id'], session['device_id'])

    new_password_hash = await asyncio.get_running_loop().run_in_executor(
        None, generate_password_hash, data.new_password
    )
    db.execute(
        "UPDATE users SET password_hash=? WHERE id=?", 
        (new_password_hash, current_user['id'])
    )
    db.execute(
        "DELETE FROM user_devices WHERE user_id=? AND (token IS NULL OR token!=?)",
        (current_user['id'], current_token),
    )
    db.commit()
    await manager.close_user_connections(current_user['username'])
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
    safe_nickname = sanitize_plain_text(data.nickname or current_user['username'], 64) or current_user['username']
    db.execute(
        "UPDATE users SET nickname=?, avatar=? WHERE id=?", 
        (safe_nickname, avatar, current_user['id'])
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
        SELECT device_id, device_name, user_agent, push_token, token, last_login,
               ip_address, country, last_seen
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
            "last_seen": row["last_seen"],
            "ip_address": row["ip_address"],
            "country": row["country"],
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
        client_ip(request),
        (request.headers.get("CF-IPCountry") or "")[:16],
    )
    db.commit()
    return {"status": "success"}

@router.post("/user/devices/{device_id}/logout")
async def logout_device(
    device_id: str,
    data: DeviceLogoutData,
    request: Request,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    if len(device_id) > 128:
        raise HTTPException(status_code=400, detail="设备标识无效")
    rate_key = f"device-logout:{current_user['id']}:{client_ip(request)}"
    retry_after = login_rate_limiter.retry_after(rate_key)
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="密码尝试过多，请稍后再试",
            headers={"Retry-After": str(retry_after)},
        )
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None,
        check_password_hash,
        current_user["password_hash"],
        data.password,
    )
    if not password_matches:
        login_rate_limiter.record_failure(rate_key)
        raise HTTPException(status_code=400, detail="密码错误")

    login_rate_limiter.reset(rate_key)
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


@router.get("/user/security")
async def get_security_settings(current_user = Depends(get_current_user)):
    return {
        "status": "success",
        "data": {
            "two_factor_enabled": bool(current_user.get("two_factor_enabled", 0)),
            "read_receipts_enabled": bool(current_user.get("read_receipts_enabled", 1)),
        },
    }


@router.put("/user/security/preferences")
async def update_security_preferences(
    data: SecurityPreferencesData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    db.execute(
        "UPDATE users SET read_receipts_enabled=? WHERE id=?",
        (int(data.read_receipts_enabled), current_user['id']),
    )
    db.commit()
    return {"status": "success"}


@router.get("/user/login-history")
async def get_login_history(current_user = Depends(get_current_user), db = Depends(get_db)):
    rows = db.execute(
        """
        SELECT id, device_id, device_name, ip_address, country, user_agent, success, created_at
        FROM login_history WHERE user_id=? ORDER BY id DESC LIMIT 100
        """,
        (current_user['id'],),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.post("/user/two-factor/setup")
async def setup_two_factor(
    data: DeviceLogoutData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None, check_password_hash, current_user['password_hash'], data.password
    )
    if not password_matches:
        raise HTTPException(status_code=400, detail="密码错误")
    secret = generate_totp_secret()
    db.execute(
        "UPDATE users SET two_factor_secret=?, two_factor_enabled=0 WHERE id=?",
        (secret, current_user['id']),
    )
    db.commit()
    label = urllib.parse.quote(f"OpenBoard:{current_user['username']}")
    issuer = urllib.parse.quote("OpenBoard")
    uri = f"otpauth://totp/{label}?secret={secret}&issuer={issuer}&digits=6&period=30"
    return {"status": "success", "secret": secret, "otpauth_uri": uri}


@router.post("/user/two-factor/confirm")
async def confirm_two_factor(
    data: TwoFactorConfirmData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    secret = current_user.get('two_factor_secret')
    if not verify_totp(secret, data.code):
        raise HTTPException(status_code=400, detail="动态验证码错误")
    db.execute("UPDATE users SET two_factor_enabled=1 WHERE id=?", (current_user['id'],))
    db.execute(
        "INSERT INTO notifications (content, sender, target_user) VALUES ('两步验证已开启', '安全中心', ?)",
        (current_user['username'],),
    )
    db.commit()
    return {"status": "success"}


@router.post("/user/two-factor/disable")
async def disable_two_factor(
    data: TwoFactorDisableData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None, check_password_hash, current_user['password_hash'], data.password
    )
    if not password_matches or not verify_totp(current_user.get('two_factor_secret'), data.code):
        raise HTTPException(status_code=400, detail="密码或动态验证码错误")
    db.execute(
        "UPDATE users SET two_factor_enabled=0, two_factor_secret=NULL WHERE id=?",
        (current_user['id'],),
    )
    db.commit()
    return {"status": "success"}


@router.post("/user/logout-all")
async def logout_all_devices(
    data: LogoutAllData,
    response: Response,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    password_matches = await asyncio.get_running_loop().run_in_executor(
        None, check_password_hash, current_user['password_hash'], data.password
    )
    if not password_matches:
        raise HTTPException(status_code=400, detail="密码错误")
    sessions = db.execute(
        "SELECT device_id, token FROM user_devices WHERE user_id=?", (current_user['id'],)
    ).fetchall()
    for session in sessions:
        revoke_token(db, session['token'], current_user['id'], session['device_id'])
    db.execute("DELETE FROM user_devices WHERE user_id=?", (current_user['id'],))
    db.execute("UPDATE users SET token=NULL WHERE id=?", (current_user['id'],))
    db.commit()
    response.delete_cookie(key="token", path="/")
    await manager.close_user_connections(current_user['username'])
    return {"status": "success", "msg": "所有设备已退出登录"}

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
