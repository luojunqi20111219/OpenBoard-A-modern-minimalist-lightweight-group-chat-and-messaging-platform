import os
import re
import uuid
import html
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse
from app.config import Config
from app.database import get_db
from app.models import MessageData
from app.auth import get_current_user
from app.websocket import manager

router = APIRouter(prefix="/api")

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'pdf', 'docx', 'txt', 'zip'}

# XSS protection using bleach (safe fallback to standard html.escape)
try:
    import bleach
    def sanitize_xss(text: str) -> str:
        # Standard bleach clean removing all elements while keeping safe plain text
        return bleach.clean(text, tags=[], strip=True)
except ImportError:
    def sanitize_xss(text: str) -> str:
        return html.escape(text)

def allowed_file(filename: str) -> bool:
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    return ext in ALLOWED_EXTENSIONS

@router.get("/messages")
async def get_messages(
    request: Request, 
    room_id: int = 0, 
    target_user: Optional[str] = None, 
    current_user = Depends(get_current_user), 
    db = Depends(get_db)
):
    blocked_list = [u.strip() for u in (current_user['blocked_users'] or '').split(',') if u.strip()]
    
    if target_user:
        my_name = current_user['username']
        rows = db.execute("""
            SELECT m.id, m.content, m.created_at as time, u.nickname, u.username as name, u.avatar
            FROM messages m LEFT JOIN users u ON m.name = u.username 
            WHERE (m.name = ? AND m.receiver = ?) OR (m.name = ? AND m.receiver = ?) 
            ORDER BY m.id ASC LIMIT 100
        """, (my_name, target_user, target_user, my_name)).fetchall()
    else:
        rows = db.execute("""
            SELECT m.id, m.content, m.created_at as time, u.nickname, u.username as name, u.avatar
            FROM messages m LEFT JOIN users u ON m.name = u.username 
            WHERE m.room_id = ? AND m.receiver IS NULL 
            ORDER BY m.id ASC LIMIT 100
        """, (room_id,)).fetchall()
        
    return {"status": "success", "data": [dict(r) for r in rows if r['name'] not in blocked_list]}

@router.post("/messages")
async def post_message(data: MessageData, current_user = Depends(get_current_user), db = Depends(get_db)):
    # 1. Clean message to prevent XSS injection
    clean_content = sanitize_xss(data.content)
    if not clean_content.strip():
        raise HTTPException(status_code=400, detail="消息内容不能为空")
        
    # 2. Handle private messages block checks
    if data.receiver:
        receiver_user = db.execute("SELECT blocked_users FROM users WHERE username=?", (data.receiver,)).fetchone()
        if receiver_user:
            receiver_blocked_list = [u.strip() for u in (receiver_user['blocked_users'] or '').split(',') if u.strip()]
            if current_user['username'] in receiver_blocked_list:
                raise HTTPException(status_code=403, detail="对方已将您拉黑，无法发送消息")

    # 3. Handle channel speak permission checks
    if data.room_id > 0 and not data.receiver:
        group = db.execute("SELECT * FROM groups WHERE id=?", (data.room_id,)).fetchone()
        if group:
            if group['is_frozen']:
                raise HTTPException(status_code=403, detail="此群聊已被管理员冻结，全员禁言")
            if group['owner_id'] != current_user['id'] and current_user['role'] != 1:
                if group['speak_mode'] == 1:
                    w_list = [u.strip() for u in (group['white_speak'] or '').split(',') if u.strip()]
                    if current_user['username'] not in w_list:
                        raise HTTPException(status_code=403, detail="您不在该群的发言白名单中")
                else:
                    b_list = [u.strip() for u in (group['black_speak'] or '').split(',') if u.strip()]
                    if current_user['username'] in b_list:
                        raise HTTPException(status_code=403, detail="您已被群主禁言")
                        
    # 4. Insert message
    if data.reply_to:
        cursor = db.execute(
            "INSERT INTO messages (name, content, room_id, receiver, reply) VALUES (?, ?, ?, ?, ?)", 
            (current_user['username'], clean_content, data.room_id, data.receiver, data.reply_to)
        )
    else:
        cursor = db.execute(
            "INSERT INTO messages (name, content, room_id, receiver) VALUES (?, ?, ?, ?)", 
            (current_user['username'], clean_content, data.room_id, data.receiver)
        )
    msg_id = cursor.lastrowid
    db.commit()
    
    sender_info = db.execute("SELECT nickname, avatar FROM users WHERE username=?", (current_user['username'],)).fetchone()
    
    # 5. Broadcast via WebSocket
    await manager.broadcast({
        "type": "message",
        "data": {
            "id": msg_id,
            "reply_to": data.reply_to,
            "mentions": [m.group(1) for m in re.finditer(r"@([\w]+)", clean_content)],
            "content": clean_content,
            "time": "刚刚", 
            "nickname": sender_info['nickname'] if sender_info else current_user['nickname'],
            "name": current_user['username'],
            "avatar": sender_info['avatar'] if sender_info else current_user['avatar'],
            "room_id": data.room_id,
            "receiver": data.receiver
        }
    }, room_id=data.room_id, receiver=data.receiver, sender=current_user['username'])
    
    return {"status": "success"}

@router.delete("/messages/{msg_id}")
async def recall_message(msg_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    msg = db.execute(
        "SELECT *, (strftime('%s', 'now') - strftime('%s', created_at)) as age_seconds FROM messages WHERE id=?", 
        (msg_id,)
    ).fetchone()
    
    if not msg:
        raise HTTPException(status_code=404, detail="消息不存在")
        
    if msg['name'] != current_user['username'] and current_user['role'] != 1:
        raise HTTPException(status_code=403, detail="无权撤回")
        
    if msg['age_seconds'] is not None and msg['age_seconds'] > 120 and current_user['role'] != 1:
        raise HTTPException(status_code=403, detail="只能撤回2分钟内的消息")
        
    db.execute("UPDATE messages SET content='[system_recalled]' WHERE id=?", (msg_id,))
    db.commit()
    
    # Broadcast recall event
    await manager.broadcast({
        "type": "recall",
        "msg_id": msg_id,
        "user": msg['name'],
        "room_id": msg['room_id'],
        "receiver": msg['receiver']
    }, room_id=msg['room_id'], receiver=msg['receiver'], sender=msg['name'])
    
    return {"status": "success"}

@router.post("/upload")
async def upload_file(file: UploadFile = File(...), current_user = Depends(get_current_user)):
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超出10MB限制")
        
    if not allowed_file(file.filename):
        raise HTTPException(status_code=400, detail="文件格式安全审查未通过。仅支持图片、pdf、docx、txt及zip包")
        
    ext = file.filename.rsplit('.', 1)[1].lower()
    secure_filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(Config.UPLOAD_DIR, secure_filename)
    
    with open(filepath, "wb") as f:
        f.write(contents)
        
    return {
        "status": "success", 
        "url": f"/uploads/{secure_filename}", 
        "filename": file.filename,
        "download_url": f"/api/download/{secure_filename}?name={file.filename}"
    }

@router.get("/download/{filename}")
async def download_file(filename: str, name: Optional[str] = None):
    # Strip path traversal elements to secure download
    safe_filename = os.path.basename(filename)
    filepath = os.path.join(Config.UPLOAD_DIR, safe_filename)
    if os.path.exists(filepath):
        return FileResponse(filepath, filename=name or safe_filename)
    raise HTTPException(status_code=404, detail="文件不存在")

@router.get("/notifications")
async def get_notifications(current_user = Depends(get_current_user), db = Depends(get_db)):
    notices = db.execute("""
        SELECT * FROM notifications 
        WHERE target_user IS NULL OR target_user = ? 
        ORDER BY id DESC LIMIT 20
    """, (current_user['username'],)).fetchall()
    
    return {
        "status": "success", 
        "data": [dict(n) for n in notices], 
        "last_read_id": current_user['last_read_notice_id']
    }

@router.post("/notifications/read")
async def mark_notifications_read(current_user = Depends(get_current_user), db = Depends(get_db)):
    max_id_row = db.execute("SELECT MAX(id) as max_id FROM notifications").fetchone()
    max_id = max_id_row['max_id'] if max_id_row and max_id_row['max_id'] else 0
    db.execute("UPDATE users SET last_read_notice_id=? WHERE id=?", (max_id, current_user['id']))
    db.commit()
    return {"status": "success"}

@router.get("/check_update")
async def check_update():
    import httpx
    try:
        url = f"https://api.github.com/repos/{Config.REPO_URL}/releases/latest"
        async with httpx.AsyncClient(timeout=5.0) as client:
            headers = {"User-Agent": "OpenBoard-Update-Checker"}
            response = await client.get(url, headers=headers)
            if response.status_code == 200:
                data = response.json()
                latest_tag = data.get("tag_name", "")
                latest_version = latest_tag.replace("v", "").strip()
                current_version = Config.CURRENT_VERSION.replace("v", "").strip()
                has_update = latest_version != current_version and latest_version > current_version
                
                return {
                    "status": "success",
                    "current": Config.CURRENT_VERSION,
                    "latest": latest_tag,
                    "has_update": has_update,
                    "url": data.get("html_url"),
                    "body": data.get("body")
                }
            else:
                return {"status": "error", "msg": "无法连接到 GitHub"}
    except Exception as e:
        return {"status": "error", "msg": str(e)}
