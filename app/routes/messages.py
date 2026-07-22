import os
import re
import uuid
import html
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, BackgroundTasks
from fastapi.responses import FileResponse
from app.config import Config
from app.database import get_db
from app.models import MessageData, ForwardMessageData, FavoriteEmojiData
from app.auth import get_current_user
from app.routes.groups import can_view_group
from app.websocket import manager

router = APIRouter(prefix="/api")

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'pdf', 'docx', 'txt', 'zip', 'apk'}
MESSAGE_RECALL_WINDOW_SECONDS = 2 * 60


def serialize_message(row, current_user):
    message = dict(row)
    age_seconds = message.pop('age_seconds', None)
    is_admin = current_user['role'] == 1
    is_owner = message['name'] == current_user['username']
    is_recalled = message['content'] == '[system_recalled]'
    within_window = age_seconds is not None and age_seconds < MESSAGE_RECALL_WINDOW_SECONDS

    message['can_recall'] = not is_recalled and (is_admin or (is_owner and within_window))
    message['recall_expires_in'] = (
        max(0, MESSAGE_RECALL_WINDOW_SECONDS - int(age_seconds))
        if is_owner and within_window and not is_recalled
        else 0
    )
    return message

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

    if target_user and len(target_user) > 64:
        raise HTTPException(status_code=400, detail="用户标识无效")
    if room_id < 0:
        raise HTTPException(status_code=400, detail="群聊标识无效")
    if not target_user and room_id > 0:
        group = db.execute("SELECT * FROM groups WHERE id=?", (room_id,)).fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="群聊不存在")
        if not can_view_group(
            group, current_user['username'], current_user['id'], current_user['role']
        ):
            raise HTTPException(status_code=403, detail="无权查看该群聊")

    if target_user:
        my_name = current_user['username']
        rows = db.execute("""
            SELECT m.id, m.content, m.created_at as time, u.nickname, u.username as name, u.avatar,
                   (strftime('%s', 'now') - strftime('%s', m.created_at)) as age_seconds
            FROM messages m LEFT JOIN users u ON m.name = u.username 
            WHERE (m.name = ? AND m.receiver = ?) OR (m.name = ? AND m.receiver = ?) 
            ORDER BY m.id ASC LIMIT 100
        """, (my_name, target_user, target_user, my_name)).fetchall()
    else:
        rows = db.execute("""
            SELECT m.id, m.content, m.created_at as time, u.nickname, u.username as name, u.avatar,
                   (strftime('%s', 'now') - strftime('%s', m.created_at)) as age_seconds
            FROM messages m LEFT JOIN users u ON m.name = u.username 
            WHERE m.room_id = ? AND m.receiver IS NULL 
            ORDER BY m.id ASC LIMIT 100
        """, (room_id,)).fetchall()
        
    return {
        "status": "success",
        "data": [serialize_message(r, current_user) for r in rows if r['name'] not in blocked_list]
    }

@router.post("/messages")
async def post_message(
    data: MessageData, 
    background_tasks: BackgroundTasks,
    current_user = Depends(get_current_user), 
    db = Depends(get_db)
):
    # 1. Clean message to prevent XSS injection
    clean_content = sanitize_xss(data.content)
    if not clean_content.strip():
        raise HTTPException(status_code=400, detail="消息内容不能为空")
        
    # 2. Handle private messages block checks
    if data.receiver:
        receiver_user = db.execute("SELECT blocked_users FROM users WHERE username=?", (data.receiver,)).fetchone()
        if not receiver_user:
            raise HTTPException(status_code=404, detail="接收用户不存在")
        if receiver_user:
            receiver_blocked_list = [u.strip() for u in (receiver_user['blocked_users'] or '').split(',') if u.strip()]
            if current_user['username'] in receiver_blocked_list:
                raise HTTPException(status_code=403, detail="对方已将您拉黑，无法发送消息")
        
        # Check if users are friends (skip for admins and filehelper)
        if current_user['role'] != 1 and data.receiver != 'filehelper':
            from app.routes.friends import are_friends
            if not are_friends(db, current_user['username'], data.receiver):
                raise HTTPException(status_code=403, detail="你们还不是好友，无法发送私信")

    # 3. Handle channel speak permission checks
    if data.room_id > 0 and not data.receiver:
        group = db.execute("SELECT * FROM groups WHERE id=?", (data.room_id,)).fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="群聊不存在")
        if not can_view_group(
            group, current_user['username'], current_user['id'], current_user['role']
        ):
            raise HTTPException(status_code=403, detail="无权在该群聊发送消息")
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
            "receiver": data.receiver,
            "can_recall": True,
            "recall_expires_in": MESSAGE_RECALL_WINDOW_SECONDS
        }
    }, room_id=data.room_id, receiver=data.receiver, sender=current_user['username'])
    
    # 6. Push via HMS (Huawei Push)
    sender_nickname = sender_info['nickname'] if sender_info else current_user['nickname']
    body_preview = clean_content
    if len(body_preview) > 50:
        body_preview = body_preview[:50] + "..."

    if data.receiver:
        # Private Message Push - send to all active devices of receiver (including legacy fallback)
        tokens_rows = db.execute("""
            SELECT d.push_token 
            FROM user_devices d JOIN users u ON d.user_id = u.id 
            WHERE u.username = ? AND d.push_token IS NOT NULL
            UNION
            SELECT push_token 
            FROM users 
            WHERE username = ? AND push_token IS NOT NULL 
              AND username NOT IN (SELECT u.username FROM user_devices d JOIN users u ON d.user_id = u.id)
        """, (data.receiver, data.receiver)).fetchall()
        
        target_tokens = [r['push_token'] for r in tokens_rows if r['push_token']]
        
        if target_tokens:
            from app.hms_push import send_hms_push
            background_tasks.add_task(
                send_hms_push,
                target_tokens,
                f"来自 {sender_nickname} 的私信",
                body_preview,
                0,
                current_user['username']
            )
    elif data.room_id > 0:
        # Group Message Push - send to all active devices of group members (including legacy fallback)
        group = db.execute("SELECT * FROM groups WHERE id=?", (data.room_id,)).fetchone()
        if group:
            group_name = group['name']
            all_push_devices = db.execute("""
                SELECT u.username, d.push_token 
                FROM user_devices d JOIN users u ON d.user_id = u.id 
                WHERE d.push_token IS NOT NULL AND u.username != ?
                UNION
                SELECT username, push_token 
                FROM users 
                WHERE push_token IS NOT NULL AND username != ? 
                  AND username NOT IN (SELECT u.username FROM user_devices d JOIN users u ON d.user_id = u.id)
            """, (current_user['username'], current_user['username'])).fetchall()
            
            target_tokens = []
            for u in all_push_devices:
                username = u['username']
                can_view = True
                if group['view_mode'] == 1:
                    w_list = [name.strip() for name in (group['white_view'] or '').split(',') if name.strip()]
                    if username not in w_list:
                        can_view = False
                else:
                    b_list = [name.strip() for name in (group['black_view'] or '').split(',') if name.strip()]
                    if username in b_list:
                        can_view = False
                        
                if can_view:
                    target_tokens.append(u['push_token'])
                    
            if target_tokens:
                from app.hms_push import send_hms_push
                background_tasks.add_task(
                    send_hms_push,
                    target_tokens,
                    f"群【{group_name}】-{sender_nickname}",
                    body_preview,
                    data.room_id,
                    None
                )
    
    return {"status": "success"}

@router.post("/messages/{msg_id}/forward")
async def forward_message(
    msg_id: int,
    data: ForwardMessageData,
    background_tasks: BackgroundTasks,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    if data.receiver and data.room_id != 0:
        raise HTTPException(status_code=400, detail="私聊转发不能同时指定群聊")

    source = db.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not source:
        raise HTTPException(status_code=404, detail="消息不存在")
    if source['content'] == '[system_recalled]':
        raise HTTPException(status_code=409, detail="已撤回的消息不能转发")

    is_admin = current_user['role'] == 1
    if source['receiver']:
        participants = {source['name'], source['receiver']}
        if current_user['username'] not in participants and not is_admin:
            raise HTTPException(status_code=403, detail="无权转发该私聊消息")
    elif source['room_id'] > 0:
        source_group = db.execute("SELECT * FROM groups WHERE id=?", (source['room_id'],)).fetchone()
        if not source_group or not can_view_group(
            source_group, current_user['username'], current_user['id'], current_user['role']
        ):
            raise HTTPException(status_code=403, detail="无权转发该群聊消息")

    await post_message(
        MessageData(content=source['content'], room_id=data.room_id, receiver=data.receiver),
        background_tasks,
        current_user,
        db,
    )
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
        
    if msg['content'] == '[system_recalled]':
        raise HTTPException(status_code=409, detail="Message has already been recalled")

    if current_user['role'] != 1 and (
        msg['age_seconds'] is None or msg['age_seconds'] >= MESSAGE_RECALL_WINDOW_SECONDS
    ):
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
    original_filename = os.path.basename(file.filename or "file")[:255]
    if allowed_file(original_filename):
        ext = original_filename.rsplit('.', 1)[1].lower() if '.' in original_filename else ""
        display_filename = original_filename
    else:
        ext = "1"
        display_filename = f"{original_filename}.1"
        
    secure_filename = f"{uuid.uuid4().hex}.{ext}" if ext else f"{uuid.uuid4().hex}"
    filepath = os.path.join(Config.UPLOAD_DIR, secure_filename)
    
    total_size = 0
    try:
        with open(filepath, "wb") as output:
            while chunk := await file.read(1024 * 1024):
                total_size += len(chunk)
                if total_size > MAX_FILE_SIZE:
                    raise HTTPException(status_code=413, detail="文件大小超过50MB限制")
                output.write(chunk)
    except Exception:
        if os.path.exists(filepath):
            os.remove(filepath)
        raise
    finally:
        await file.close()
        
    return {
        "status": "success", 
        "url": f"/uploads/{secure_filename}", 
        "filename": display_filename,
        "download_url": f"/api/download/{secure_filename}?name={display_filename}"
    }

@router.get("/download/{filename}")
async def download_file(filename: str, name: Optional[str] = None):
    # Strip path traversal elements to secure download
    safe_filename = os.path.basename(filename)
    filepath = os.path.join(Config.UPLOAD_DIR, safe_filename)
    if os.path.exists(filepath):
        download_name = os.path.basename(name or safe_filename)[:255]
        return FileResponse(filepath, filename=download_name)
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

@router.get("/favorites/emojis")
async def get_favorite_emojis(current_user = Depends(get_current_user), db = Depends(get_db)):
    rows = db.execute("SELECT emoji FROM favorite_emojis WHERE username = ? ORDER BY created_at DESC", (current_user['username'],)).fetchall()
    return {"status": "success", "data": [r['emoji'] for r in rows]}

@router.post("/favorites/emojis")
async def add_favorite_emoji(data: FavoriteEmojiData, current_user = Depends(get_current_user), db = Depends(get_db)):
    try:
        db.execute(
            "INSERT OR IGNORE INTO favorite_emojis (username, emoji) VALUES (?, ?)",
            (current_user['username'], data.emoji)
        )
        db.commit()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/favorites/emojis/delete")
async def delete_favorite_emoji(data: FavoriteEmojiData, current_user = Depends(get_current_user), db = Depends(get_db)):
    try:
        db.execute(
            "DELETE FROM favorite_emojis WHERE username = ? AND emoji = ?",
            (current_user['username'], data.emoji)
        )
        db.commit()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/messages/export")
async def export_messages(current_user = Depends(get_current_user), db = Depends(get_db)):
    import json
    from fastapi import Response
    
    # 获取用户有权访问的所有群聊 ID
    groups = db.execute("SELECT id, view_mode, white_view, black_view FROM groups").fetchall()
    allowed_rooms = [0] # 0 代表公共大厅
    for g in groups:
        room_id = g['id']
        view_mode = g['view_mode']
        w_list = [name.strip() for name in (g['white_view'] or '').split(',') if name.strip()]
        b_list = [name.strip() for name in (g['black_view'] or '').split(',') if name.strip()]
        if view_mode == 1:
            if current_user['username'] in w_list:
                allowed_rooms.append(room_id)
        else:
            if current_user['username'] not in b_list:
                allowed_rooms.append(room_id)
                
    # 查询当前用户发送、接收，或所属群聊的消息历史
    placeholders = ', '.join(['?'] * len(allowed_rooms))
    query = f"""
        SELECT id, name, content, created_at, room_id, reply, receiver
        FROM messages
        WHERE name = ? OR receiver = ? OR (room_id IN ({placeholders}) AND receiver IS NULL)
        ORDER BY id ASC
    """
    params = [current_user['username'], current_user['username']] + allowed_rooms
    rows = db.execute(query, params).fetchall()
    
    import urllib.parse
    safe_username = urllib.parse.quote(current_user['username'])
    data = [dict(r) for r in rows]
    json_str = json.dumps(data, ensure_ascii=False, indent=2)
    
    return Response(
        content=json_str,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=openboard_chat_history_{safe_username}.json"}
    )

@router.post("/messages/import")
async def import_messages(file: UploadFile = File(...), current_user = Depends(get_current_user), db = Depends(get_db)):
    import json
    contents = await file.read()
    try:
        messages_data = json.loads(contents)
    except Exception:
        raise HTTPException(status_code=400, detail="无效的 JSON 文件")
        
    if not isinstance(messages_data, list):
        raise HTTPException(status_code=400, detail="JSON 数据必须是列表形式")
        
    imported_count = 0
    for msg in messages_data:
        content = msg.get("content")
        room_id = msg.get("room_id", 0)
        receiver = msg.get("receiver")
        reply = msg.get("reply")
        created_at = msg.get("created_at") or msg.get("time")
        name = msg.get("name")
        
        # 基本校验
        if not content or not name:
            continue
            
        # 安全验证：只能导入发送人或接收人是当前用户，或者是当前用户有权访问的群聊的消息
        if name != current_user['username'] and receiver != current_user['username']:
            if room_id > 0 and not receiver:
                # 校验群聊访问权限
                group = db.execute("SELECT view_mode, white_view, black_view FROM groups WHERE id=?", (room_id,)).fetchone()
                if not group:
                    continue
                view_mode = group['view_mode']
                w_list = [n.strip() for n in (group['white_view'] or '').split(',') if n.strip()]
                b_list = [n.strip() for n in (group['black_view'] or '').split(',') if n.strip()]
                if view_mode == 1:
                    if current_user['username'] not in w_list:
                        continue
                else:
                    if current_user['username'] in b_list:
                        continue
            else:
                continue
                
        # 查重：避免重复导入相同的消息
        dup = db.execute("""
            SELECT id FROM messages 
            WHERE name = ? AND content = ? AND room_id = ? AND (receiver = ? OR (receiver IS NULL AND ? IS NULL)) AND (created_at = ? OR (created_at IS NULL AND ? IS NULL))
        """, (name, content, room_id, receiver, receiver, created_at, created_at)).fetchone()
        
        if not dup:
            db.execute("""
                INSERT INTO messages (name, content, room_id, receiver, reply, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (name, content, room_id, receiver, reply, created_at))
            imported_count += 1
            
    db.commit()
    return {"status": "success", "imported_count": imported_count}
