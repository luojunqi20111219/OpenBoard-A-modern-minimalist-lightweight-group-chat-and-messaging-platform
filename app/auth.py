import datetime
import hashlib
import uuid
import jwt
from typing import Optional
from fastapi import Request, HTTPException, Depends
from app.config import Config
from app.database import get_db

def create_access_token(data: dict, expires_minutes: Optional[int] = None):
    to_encode = data.copy()
    to_encode.setdefault("jti", uuid.uuid4().hex)
    lifetime = expires_minutes if expires_minutes is not None else Config.JWT_EXP_MINUTES
    expire = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=lifetime)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, Config.JWT_SECRET, algorithm=Config.JWT_ALGORITHM)
    return encoded_jwt

def verify_token(token: str, db) -> dict:
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    if db.execute("SELECT 1 FROM revoked_sessions WHERE token_hash=?", (token_hash,)).fetchone():
        return None
    # 1. Try standard JWT decode
    try:
        payload = jwt.decode(token, Config.JWT_SECRET, algorithms=[Config.JWT_ALGORITHM])
        username = payload.get("username")
        if username:
            user = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
            if user:
                return dict(user)
    except jwt.ExpiredSignatureError:
        return None
    except jwt.PyJWTError:
        pass

    # 2. Backwards compatibility fallback: check legacy database token lookup
    user = db.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
    if user:
        return dict(user)
        
    return None

def revoke_token(db, token: str, user_id: int, device_id: str) -> None:
    if not token:
        return
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    db.execute(
        "INSERT OR IGNORE INTO revoked_sessions (token_hash, user_id, device_id) VALUES (?, ?, ?)",
        (token_hash, user_id, device_id),
    )

async def get_current_user(request: Request, db = Depends(get_db)) -> dict:
    # Check Authorization Header
    token = request.headers.get("Authorization")
    
    # Check Cookie Fallback (useful for normal page rendering / GET endpoints)
    if not token:
        token = request.cookies.get("token")
        
    if not token:
        raise HTTPException(status_code=403, detail="未登录")
        
    user = verify_token(token, db)
    if not user:
        raise HTTPException(status_code=403, detail="登录已失效，请重新登录")
        
    if user.get("is_banned") == 1:
        raise HTTPException(status_code=403, detail="您的账号已被管理员封禁")
        
    return user

async def get_current_admin(current_user = Depends(get_current_user)) -> dict:
    if current_user.get("role") != 1 and current_user.get("username") not in Config.ALLOWED_ADMINS:
        raise HTTPException(status_code=403, detail="您无权进行此项管理员操作")
    return current_user
