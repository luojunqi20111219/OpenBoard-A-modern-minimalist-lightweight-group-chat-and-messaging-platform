import os
import re
import uuid
import html
import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, BackgroundTasks, Query
from fastapi.responses import FileResponse
from app.config import Config
from app.database import get_db
from app.models import (
    MessageData, ForwardMessageData, FavoriteEmojiData, MessageEditData,
    MessageReadData, ConversationSettingData,
)
from app.auth import get_current_user
from app.routes.groups import can_view_group
from app.websocket import manager

router = APIRouter(prefix="/api")

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'pdf', 'docx', 'txt', 'zip', 'apk'}
IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'}
MESSAGE_RECALL_WINDOW_SECONDS = 2 * 60
MESSAGE_EDIT_WINDOW_SECONDS = 2 * 60


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
    message['can_edit'] = not is_recalled and is_owner and within_window
    message['edit_expires_in'] = (
        max(0, MESSAGE_EDIT_WINDOW_SECONDS - int(age_seconds))
        if is_owner and within_window and not is_recalled
        else 0
    )
    message['edited'] = bool(message.get('edited_at'))
    message['read_count'] = int(message.get('read_count') or 0)
    return message


def ensure_message_visible(message, current_user, db):
    if message['receiver']:
        if current_user['role'] != 1 and current_user['username'] not in {
            message['name'], message['receiver']
        }:
            raise HTTPException(status_code=403, detail="无权查看该消息")
        return
    if message['room_id'] > 0:
        group = db.execute("SELECT * FROM groups WHERE id=?", (message['room_id'],)).fetchone()
        if not group or not can_view_group(
            group, current_user['username'], current_user['id'], current_user['role'], db
        ):
            raise HTTPException(status_code=403, detail="无权查看该消息")

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
    before_id: Optional[int] = Query(default=None, ge=1),
    after_id: Optional[int] = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=50),
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
            group, current_user['username'], current_user['id'], current_user['role'], db
        ):
            raise HTTPException(status_code=403, detail="无权查看该群聊")

    if before_id and after_id is not None:
        raise HTTPException(status_code=400, detail="before_id 与 after_id 不能同时使用")

    cursor_sql = ""
    cursor_params = []
    if before_id:
        cursor_sql = " AND m.id < ?"
        cursor_params.append(before_id)
    elif after_id is not None:
        cursor_sql = " AND m.id > ?"
        cursor_params.append(after_id)
    order = "ASC" if after_id is not None else "DESC"
    select_sql = """
        SELECT m.id, m.content, m.created_at as time, m.room_id, m.receiver,
               m.reply AS reply_to, m.edited_at, m.edit_count, m.client_id,
               u.nickname, COALESCE(u.username, m.name) as name, u.avatar,
               (strftime('%s', 'now') - strftime('%s', m.created_at)) as age_seconds,
               (SELECT COUNT(*) FROM message_reads mr WHERE mr.msg_id=m.id) AS read_count
        FROM messages m LEFT JOIN users u ON m.name = u.username
    """
    if target_user:
        my_name = current_user['username']
        rows = db.execute(
            select_sql + """
            WHERE ((m.name = ? AND m.receiver = ?) OR (m.name = ? AND m.receiver = ?))
            """ + cursor_sql + f" ORDER BY m.id {order} LIMIT ?",
            [my_name, target_user, target_user, my_name] + cursor_params + [limit + 1],
        ).fetchall()
    else:
        rows = db.execute(
            select_sql + " WHERE m.room_id = ? AND m.receiver IS NULL" + cursor_sql
            + f" ORDER BY m.id {order} LIMIT ?",
            [room_id] + cursor_params + [limit + 1],
        ).fetchall()

    has_more = len(rows) > limit
    rows = list(rows[:limit])
    if order == "DESC":
        rows.reverse()
    visible_rows = [row for row in rows if row['name'] not in blocked_list]
    return {
        "status": "success",
        "data": [serialize_message(row, current_user) for row in visible_rows],
        "pagination": {
            "limit": limit,
            "has_more": has_more,
            "next_before_id": visible_rows[0]['id'] if has_more and visible_rows else None,
            "last_id": visible_rows[-1]['id'] if visible_rows else (after_id or 0),
        },
    }

@router.post("/messages")
async def post_message(
    data: MessageData, 
    background_tasks: BackgroundTasks,
    current_user = Depends(get_current_user), 
    db = Depends(get_db)
):
    if data.client_id:
        existing = db.execute(
            "SELECT id FROM messages WHERE name=? AND client_id=?",
            (current_user['username'], data.client_id),
        ).fetchone()
        if existing:
            return {"status": "success", "id": existing['id'], "duplicate": True}

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
            group, current_user['username'], current_user['id'], current_user['role'], db
        ):
            raise HTTPException(status_code=403, detail="无权在该群聊发送消息")
        if group:
            if group['is_frozen']:
                raise HTTPException(status_code=403, detail="此群聊已被管理员冻结，全员禁言")
            if group['owner_id'] != current_user['id'] and current_user['role'] != 1:
                membership = db.execute(
                    "SELECT muted_until FROM group_members WHERE group_id=? AND username=?",
                    (data.room_id, current_user['username']),
                ).fetchone()
                if membership and membership['muted_until'] and db.execute(
                    "SELECT datetime(?) > CURRENT_TIMESTAMP AS active", (membership['muted_until'],)
                ).fetchone()['active']:
                    raise HTTPException(status_code=403, detail="您当前处于群聊禁言状态")
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
            "INSERT INTO messages (name, content, room_id, receiver, reply, client_id) VALUES (?, ?, ?, ?, ?, ?)",
            (current_user['username'], clean_content, data.room_id, data.receiver, data.reply_to, data.client_id)
        )
    else:
        cursor = db.execute(
            "INSERT INTO messages (name, content, room_id, receiver, client_id) VALUES (?, ?, ?, ?, ?)",
            (current_user['username'], clean_content, data.room_id, data.receiver, data.client_id)
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
            "client_id": data.client_id,
            "edited_at": None,
            "edit_count": 0,
            "read_count": 0,
            "can_edit": True,
            "edit_expires_in": MESSAGE_EDIT_WINDOW_SECONDS,
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

    return {
        "status": "success",
        "id": msg_id,
        "data": {
            "id": msg_id,
            "client_id": data.client_id,
            "content": clean_content,
            "room_id": data.room_id,
            "receiver": data.receiver,
        },
    }

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
            source_group, current_user['username'], current_user['id'], current_user['role'], db
        ):
            raise HTTPException(status_code=403, detail="无权转发该群聊消息")

    result = await post_message(
        MessageData(content=source['content'], room_id=data.room_id, receiver=data.receiver),
        background_tasks,
        current_user,
        db,
    )
    return {"status": "success", "id": result.get("id")}


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


@router.put("/messages/{msg_id}")
async def edit_message(
    msg_id: int,
    data: MessageEditData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    message = db.execute(
        """
        SELECT *, (strftime('%s', 'now') - strftime('%s', created_at)) AS age_seconds
        FROM messages WHERE id=?
        """,
        (msg_id,),
    ).fetchone()
    if not message:
        raise HTTPException(status_code=404, detail="消息不存在")
    if message['name'] != current_user['username']:
        raise HTTPException(status_code=403, detail="只能编辑自己发送的消息")
    if message['content'] == '[system_recalled]':
        raise HTTPException(status_code=409, detail="已撤回的消息不能编辑")
    if message['age_seconds'] is None or message['age_seconds'] >= MESSAGE_EDIT_WINDOW_SECONDS:
        raise HTTPException(status_code=403, detail="只能编辑2分钟内的消息")

    clean_content = sanitize_xss(data.content)
    if not clean_content.strip():
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    if clean_content == message['content']:
        return {"status": "success", "unchanged": True}

    db.execute(
        "INSERT INTO message_edits (msg_id, editor, old_content) VALUES (?, ?, ?)",
        (msg_id, current_user['username'], message['content']),
    )
    db.execute(
        "UPDATE messages SET content=?, edited_at=CURRENT_TIMESTAMP, edit_count=edit_count+1 WHERE id=?",
        (clean_content, msg_id),
    )
    db.commit()
    await manager.broadcast({
        "type": "message_edited",
        "msg_id": msg_id,
        "content": clean_content,
        "edited_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "room_id": message['room_id'],
        "receiver": message['receiver'],
    }, room_id=message['room_id'], receiver=message['receiver'], sender=message['name'])
    return {"status": "success", "content": clean_content}


@router.post("/messages/read")
async def mark_messages_read(
    data: MessageReadData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    if data.target_user:
        rows = db.execute(
            """
            SELECT id FROM messages
            WHERE id<=? AND name!=? AND
                  ((name=? AND receiver=?) OR (name=? AND receiver=?))
            """,
            (
                data.up_to_id, current_user['username'], current_user['username'], data.target_user,
                data.target_user, current_user['username'],
            ),
        ).fetchall()
        conversation_key = f"user:{data.target_user}"
    else:
        if data.room_id > 0:
            group = db.execute("SELECT * FROM groups WHERE id=?", (data.room_id,)).fetchone()
            if not group or not can_view_group(
                group, current_user['username'], current_user['id'], current_user['role'], db
            ):
                raise HTTPException(status_code=403, detail="无权查看该群聊")
        rows = db.execute(
            "SELECT id FROM messages WHERE id<=? AND room_id=? AND receiver IS NULL AND name!=?",
            (data.up_to_id, data.room_id, current_user['username']),
        ).fetchall()
        conversation_key = f"room:{data.room_id}"

    db.execute(
        """
        INSERT INTO conversation_settings (username, conversation_key, last_read_id)
        VALUES (?, ?, ?)
        ON CONFLICT(username, conversation_key) DO UPDATE SET
            last_read_id=MAX(last_read_id, excluded.last_read_id), updated_at=CURRENT_TIMESTAMP
        """,
        (current_user['username'], conversation_key, data.up_to_id),
    )
    if current_user.get('read_receipts_enabled', 1):
        db.executemany(
            "INSERT OR IGNORE INTO message_reads (msg_id, user, read_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            [(row['id'], current_user['username']) for row in rows],
        )
    db.commit()
    await manager.broadcast({
        "type": "messages_read",
        "reader": current_user['username'],
        "up_to_id": data.up_to_id,
        "room_id": data.room_id,
        "receiver": data.target_user,
    }, room_id=data.room_id, receiver=data.target_user, sender=current_user['username'])
    return {"status": "success", "read_count": len(rows)}


@router.get("/messages/{msg_id}/reads")
async def get_message_reads(msg_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    message = db.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not message:
        raise HTTPException(status_code=404, detail="消息不存在")
    ensure_message_visible(message, current_user, db)
    rows = db.execute(
        """
        SELECT mr.user AS username, COALESCE(u.nickname, mr.user) AS nickname,
               u.avatar, mr.read_at
        FROM message_reads mr
        LEFT JOIN users u ON u.username=mr.user
        WHERE mr.msg_id=? AND COALESCE(u.read_receipts_enabled, 1)=1
        ORDER BY mr.read_at ASC
        """,
        (msg_id,),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.get("/messages/search")
async def search_messages(
    q: str = Query(default="", max_length=200),
    room_id: Optional[int] = Query(default=None, ge=0),
    target_user: Optional[str] = Query(default=None, max_length=64),
    kind: Optional[str] = Query(default=None, pattern="^(text|image|file)$"),
    date_from: Optional[str] = Query(default=None, max_length=10),
    date_to: Optional[str] = Query(default=None, max_length=10),
    before_id: Optional[int] = Query(default=None, ge=1),
    limit: int = Query(default=30, ge=1, le=50),
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    clauses = ["m.content!='[system_recalled]'", "(m.receiver IS NULL OR m.name=? OR m.receiver=?)"]
    params = [current_user['username'], current_user['username']]
    if q.strip():
        clauses.append("m.content LIKE ? ESCAPE '\\'")
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        params.append(f"%{escaped}%")
    if room_id is not None:
        clauses.extend(["m.room_id=?", "m.receiver IS NULL"])
        params.append(room_id)
    if target_user:
        clauses.append("((m.name=? AND m.receiver=?) OR (m.name=? AND m.receiver=?))")
        params.extend([current_user['username'], target_user, target_user, current_user['username']])
    if kind == "image":
        clauses.append("m.content LIKE '[img:%'")
    elif kind == "file":
        clauses.append("m.content LIKE '[file:%'")
    elif kind == "text":
        clauses.extend(["m.content NOT LIKE '[img:%'", "m.content NOT LIKE '[file:%'"])
    if date_from:
        clauses.append("date(m.created_at)>=date(?)")
        params.append(date_from)
    if date_to:
        clauses.append("date(m.created_at)<=date(?)")
        params.append(date_to)
    if before_id:
        clauses.append("m.id<?")
        params.append(before_id)

    rows = db.execute(
        """
        SELECT m.*, m.created_at AS time, m.reply AS reply_to,
               u.nickname, u.avatar,
               (strftime('%s', 'now') - strftime('%s', m.created_at)) AS age_seconds,
               (SELECT COUNT(*) FROM message_reads mr WHERE mr.msg_id=m.id) AS read_count
        FROM messages m LEFT JOIN users u ON u.username=m.name
        WHERE """ + " AND ".join(clauses) + " ORDER BY m.id DESC LIMIT ?",
        params + [limit * 4],
    ).fetchall()
    result = []
    for row in rows:
        try:
            ensure_message_visible(row, current_user, db)
        except HTTPException:
            continue
        result.append(serialize_message(row, current_user))
        if len(result) >= limit:
            break
    return {
        "status": "success",
        "data": result,
        "pagination": {"has_more": len(result) == limit, "next_before_id": result[-1]['id'] if result else None},
    }


@router.get("/favorites/messages")
async def get_favorite_messages(current_user = Depends(get_current_user), db = Depends(get_db)):
    rows = db.execute(
        """
        SELECT m.*, m.created_at AS time, m.reply AS reply_to, u.nickname, u.avatar,
               (strftime('%s', 'now') - strftime('%s', m.created_at)) AS age_seconds,
               (SELECT COUNT(*) FROM message_reads mr WHERE mr.msg_id=m.id) AS read_count,
               mf.created_at AS favorited_at
        FROM message_favorites mf JOIN messages m ON m.id=mf.msg_id
        LEFT JOIN users u ON u.username=m.name
        WHERE mf.username=? ORDER BY mf.id DESC LIMIT 100
        """,
        (current_user['username'],),
    ).fetchall()
    result = []
    for row in rows:
        try:
            ensure_message_visible(row, current_user, db)
        except HTTPException:
            continue
        result.append(serialize_message(row, current_user))
    return {"status": "success", "data": result}


@router.post("/favorites/messages/{msg_id}")
async def favorite_message(msg_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    message = db.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not message:
        raise HTTPException(status_code=404, detail="消息不存在")
    ensure_message_visible(message, current_user, db)
    db.execute(
        "INSERT OR IGNORE INTO message_favorites (username, msg_id) VALUES (?, ?)",
        (current_user['username'], msg_id),
    )
    db.commit()
    return {"status": "success"}


@router.delete("/favorites/messages/{msg_id}")
async def unfavorite_message(msg_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    db.execute(
        "DELETE FROM message_favorites WHERE username=? AND msg_id=?",
        (current_user['username'], msg_id),
    )
    db.commit()
    return {"status": "success"}


@router.get("/conversation-settings")
async def get_conversation_settings(current_user = Depends(get_current_user), db = Depends(get_db)):
    rows = db.execute(
        "SELECT conversation_key, is_pinned, is_muted, last_read_id FROM conversation_settings WHERE username=?",
        (current_user['username'],),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.put("/conversation-settings")
async def update_conversation_setting(
    data: ConversationSettingData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    db.execute(
        """
        INSERT INTO conversation_settings (username, conversation_key, is_pinned, is_muted)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(username, conversation_key) DO UPDATE SET
            is_pinned=excluded.is_pinned, is_muted=excluded.is_muted, updated_at=CURRENT_TIMESTAMP
        """,
        (current_user['username'], data.conversation_key, int(data.is_pinned), int(data.is_muted)),
    )
    db.commit()
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

    thumbnail_url = None
    if ext in IMAGE_EXTENSIONS:
        try:
            from PIL import Image, ImageOps
            thumbnail_name = f"{uuid.uuid4().hex}.thumb.jpg"
            thumbnail_path = os.path.join(Config.UPLOAD_DIR, thumbnail_name)
            with Image.open(filepath) as image:
                image = ImageOps.exif_transpose(image)
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.thumbnail((480, 480), Image.Resampling.LANCZOS)
                image.save(thumbnail_path, "JPEG", quality=76, optimize=True)
            thumbnail_url = f"/uploads/{thumbnail_name}"
        except Exception:
            thumbnail_url = None

    return {
        "status": "success", 
        "url": f"/uploads/{secure_filename}", 
        "thumbnail_url": thumbnail_url,
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
