from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from app.auth import get_current_user
from app.database import get_db
from app.websocket import manager

router = APIRouter(prefix="/api")

class FriendRequestData(BaseModel):
    to_user: str = Field(min_length=1, max_length=64)

class FriendActionData(BaseModel):
    from_user: str = Field(min_length=1, max_length=64)
    action: str = Field(pattern="^(accept|reject)$")

class FriendAddData(BaseModel):
    username: str = Field(min_length=1, max_length=64)

def are_friends(db, user_a: str, user_b: str) -> bool:
    """Check if two users are friends (order-independent)"""
    row = db.execute("""
        SELECT id FROM friends 
        WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)
    """, (user_a, user_b, user_b, user_a)).fetchone()
    return row is not None

@router.get("/users/search")
async def search_users(q: str = "", current_user = Depends(get_current_user), db = Depends(get_db)):
    """Search users by username or nickname"""
    if not q or len(q) < 1:
        return {"status": "success", "data": []}
    q = q[:64]
    
    rows = db.execute("""
        SELECT username, nickname, avatar FROM users
        WHERE (username LIKE ? OR nickname LIKE ?) AND username != ?
        LIMIT 20
    """, (f"%{q}%", f"%{q}%", current_user['username'])).fetchall()
    
    results = []
    for u in rows:
        u = dict(u)
        u['is_friend'] = are_friends(db, current_user['username'], u['username'])
        # Check if there is a pending request in either direction
        pending = db.execute("""
            SELECT status, from_user FROM friend_requests
            WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)
        """, (current_user['username'], u['username'], u['username'], current_user['username'])).fetchone()
        if pending:
            u['request_status'] = pending['status']
            u['request_direction'] = 'sent' if pending['from_user'] == current_user['username'] else 'received'
        else:
            u['request_status'] = None
            u['request_direction'] = None
        results.append(u)
    
    return {"status": "success", "data": results}

@router.get("/friends")
async def get_friends(current_user = Depends(get_current_user), db = Depends(get_db)):
    """Get current user's friends list"""
    rows = db.execute("""
        SELECT u.username, u.nickname, u.avatar FROM users u
        WHERE u.username IN (
            SELECT user_b FROM friends WHERE user_a=?
            UNION
            SELECT user_a FROM friends WHERE user_b=?
        )
        ORDER BY u.nickname ASC
    """, (current_user['username'], current_user['username'])).fetchall()
    
    friends = [dict(r) for r in rows]
    friends.insert(0, {
        "username": "filehelper",
        "nickname": "文件传输助手",
        "avatar": "system_filehelper"
    })
    
    return {"status": "success", "data": friends}

@router.get("/friends/requests")
async def get_friend_requests(current_user = Depends(get_current_user), db = Depends(get_db)):
    """Get pending friend requests sent to the current user"""
    rows = db.execute("""
        SELECT fr.id, fr.from_user, fr.created_at, u.nickname, u.avatar 
        FROM friend_requests fr 
        JOIN users u ON fr.from_user = u.username
        WHERE fr.to_user=? AND fr.status='pending'
        ORDER BY fr.created_at DESC
    """, (current_user['username'],)).fetchall()
    
    return {"status": "success", "data": [dict(r) for r in rows]}

@router.post("/friends/request")
async def send_friend_request(data: FriendRequestData, current_user = Depends(get_current_user), db = Depends(get_db)):
    """Send a friend request"""
    if data.to_user == current_user['username']:
        raise HTTPException(status_code=400, detail="不能添加自己为好友")
    
    target = db.execute("SELECT username, nickname FROM users WHERE username=?", (data.to_user,)).fetchone()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    
    if are_friends(db, current_user['username'], data.to_user):
        raise HTTPException(status_code=400, detail="你们已经是好友了")
    
    # Check if there is already a request from the other direction (auto-accept)
    reverse = db.execute("""
        SELECT id FROM friend_requests WHERE from_user=? AND to_user=? AND status='pending'
    """, (data.to_user, current_user['username'])).fetchone()
    
    if reverse:
        # Auto accept
        db.execute("UPDATE friend_requests SET status='accepted' WHERE from_user=? AND to_user=?", 
                   (data.to_user, current_user['username']))
        _add_friends(db, current_user['username'], data.to_user)
        db.commit()
        return {"status": "success", "msg": "对方也想加您为好友，已自动互相成为好友！", "auto_accepted": True}
    
    existing = db.execute("""
        SELECT status FROM friend_requests WHERE from_user=? AND to_user=?
    """, (current_user['username'], data.to_user)).fetchone()
    
    if existing:
        if existing['status'] == 'pending':
            raise HTTPException(status_code=400, detail="已发送过好友申请，请等待对方同意")
        else:
            db.execute("""
                UPDATE friend_requests 
                SET status='pending', created_at=CURRENT_TIMESTAMP 
                WHERE from_user=? AND to_user=?
            """, (current_user['username'], data.to_user))
            db.commit()
    else:
        try:
            db.execute("""
                INSERT INTO friend_requests (from_user, to_user, status) VALUES (?, ?, 'pending')
            """, (current_user['username'], data.to_user))
            db.commit()
        except Exception:
            raise HTTPException(status_code=400, detail="发送好友申请失败，请稍后重试")
    
    # Notify target user via WebSocket
    sender_info = db.execute("SELECT nickname, avatar FROM users WHERE username=?", (current_user['username'],)).fetchone()
    nickname = sender_info['nickname'] if sender_info else current_user['username']
    await manager.send_personal({
        "type": "friend_request",
        "from_user": current_user['username'],
        "from_nickname": nickname,
        "from_avatar": sender_info['avatar'] if sender_info else "",
    }, data.to_user)
    
    return {"status": "success", "msg": f"好友申请已发送给 {target['nickname'] or data.to_user}"}

@router.post("/friends/respond")
async def respond_friend_request(data: FriendActionData, current_user = Depends(get_current_user), db = Depends(get_db)):
    """Accept or reject a friend request"""
    req = db.execute("""
        SELECT id FROM friend_requests WHERE from_user=? AND to_user=? AND status='pending'
    """, (data.from_user, current_user['username'])).fetchone()
    
    if not req:
        raise HTTPException(status_code=404, detail="好友申请不存在或已处理")
    
    if data.action == 'accept':
        db.execute("UPDATE friend_requests SET status='accepted' WHERE from_user=? AND to_user=?",
                   (data.from_user, current_user['username']))
        _add_friends(db, data.from_user, current_user['username'])
        db.commit()
        
        # Notify requester via WebSocket
        me_info = db.execute("SELECT nickname, avatar FROM users WHERE username=?", (current_user['username'],)).fetchone()
        await manager.send_personal({
            "type": "friend_accepted",
            "by_user": current_user['username'],
            "by_nickname": me_info['nickname'] if me_info else current_user['username'],
            "by_avatar": me_info['avatar'] if me_info else "",
        }, data.from_user)
        
        return {"status": "success", "msg": "已接受好友申请！"}
    else:
        db.execute("UPDATE friend_requests SET status='rejected' WHERE from_user=? AND to_user=?",
                   (data.from_user, current_user['username']))
        db.commit()
        return {"status": "success", "msg": "已拒绝好友申请"}

@router.post("/friends/add")
async def add_friend_directly(data: FriendAddData, current_user = Depends(get_current_user), db = Depends(get_db)):
    """Keep the card shortcut, but require the recipient's consent."""
    return await send_friend_request(
        FriendRequestData(to_user=data.username),
        current_user,
        db,
    )

@router.delete("/friends/{username}")
async def remove_friend(username: str, current_user = Depends(get_current_user), db = Depends(get_db)):
    """Remove a friend"""
    db.execute("""
        DELETE FROM friends 
        WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)
    """, (current_user['username'], username, username, current_user['username']))
    db.commit()
    return {"status": "success", "msg": "已删除好友"}

def _add_friends(db, user_a: str, user_b: str):
    """Helper to insert friendship (normalized order)"""
    a, b = sorted([user_a, user_b])
    try:
        db.execute("INSERT OR IGNORE INTO friends (user_a, user_b) VALUES (?, ?)", (a, b))
    except Exception:
        pass
