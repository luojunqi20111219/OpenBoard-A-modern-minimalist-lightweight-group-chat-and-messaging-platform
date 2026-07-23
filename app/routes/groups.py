import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from app.config import Config
from app.database import get_db
from app.models import (
    GroupCreate, GroupUpdate, GroupPermissionUpdate, GroupAvatarUpdate,
    GroupAdvancedUpdate, GroupInviteData, GroupRequestActionData,
    GroupInviteActionData, GroupMemberUpdateData,
)
from app.auth import get_current_user, verify_token
from app.media import normalize_avatar
from app.security import sanitize_plain_text

router = APIRouter(prefix="/api")


def can_view_group(group, username=None, user_id=None, user_role=0, db=None):
    if group['id'] == 0:
        return True
    if username and group['owner_id'] == user_id:
        return True
    if user_role == 1 or username in Config.ALLOWED_ADMINS:
        return True
    if db and 'member_only' in group.keys() and group['member_only']:
        member = db.execute(
            "SELECT 1 FROM group_members WHERE group_id=? AND username=?",
            (group['id'], username),
        ).fetchone()
        if not member:
            return False
    if group['view_mode'] == 1:
        allowlist = [u.strip() for u in (group['white_view'] or '').split(',') if u.strip()]
        return bool(username and username in allowlist)
    blocklist = [u.strip() for u in (group['black_view'] or '').split(',') if u.strip()]
    return not (username and username in blocklist)


def require_group_manager(group_id, current_user, db):
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or group_id == 0:
        raise HTTPException(status_code=404, detail="群聊不存在")
    is_site_admin = current_user['role'] == 1 or current_user['username'] in Config.ALLOWED_ADMINS
    member = db.execute(
        "SELECT member_role FROM group_members WHERE group_id=? AND username=?",
        (group_id, current_user['username']),
    ).fetchone()
    if not is_site_admin and group['owner_id'] != current_user['id'] and (
        not member or member['member_role'] != 'admin'
    ):
        raise HTTPException(status_code=403, detail="仅群主或管理员可操作")
    return group


def audit_group(db, group_id, actor, action, target=None, detail=None):
    db.execute(
        "INSERT INTO group_audit_logs (group_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
        (group_id, actor, action, target, detail),
    )

@router.get("/groups")
async def get_groups(request: Request, db = Depends(get_db)):
    token = request.headers.get("Authorization")
    if not token:
        token = request.cookies.get("token")
        
    username = None
    user_id = None
    user_role = 0
    if token:
        user = verify_token(token, db)
        if user:
            username = user['username']
            user_id = user['id']
            user_role = user['role']
            
    groups = db.execute("SELECT * FROM groups").fetchall()
    result = []
    
    for g in groups:
        if g['id'] == 0:
            result.append(dict(g))
            continue
            
        if can_view_group(g, username, user_id, user_role, db):
            item = dict(g)
            if username:
                member = db.execute(
                    "SELECT member_role FROM group_members WHERE group_id=? AND username=?",
                    (g['id'], username),
                ).fetchone()
                item['member_role'] = member['member_role'] if member else None
            result.append(item)
            
    return {"status": "success", "data": result}

@router.post("/groups")
async def create_group(data: GroupCreate, current_user = Depends(get_current_user), db = Depends(get_db)):
    safe_name = sanitize_plain_text(data.name, 64)
    if not safe_name:
        raise HTTPException(status_code=400, detail="群聊名称不能为空")
    cursor = db.execute(
        "INSERT INTO groups (name, is_public, owner_id) VALUES (?, ?, ?)", 
        (safe_name, data.is_public, current_user['id'])
    )
    group_id = cursor.lastrowid
    db.execute(
        "INSERT INTO group_members (group_id, username, member_role) VALUES (?, ?, 'owner')",
        (group_id, current_user['username']),
    )
    audit_group(db, group_id, current_user['username'], 'create_group')
    db.commit()
    return {"status": "success", "group_id": group_id}

@router.put("/groups/{group_id}")
async def update_group(group_id: int, data: GroupUpdate, current_user = Depends(get_current_user), db = Depends(get_db)):
    if group_id == 0:
        raise HTTPException(status_code=403, detail="公共大厅不可修改")
        
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    is_admin = current_user['role'] == 1 or (current_user['username'] in Config.ALLOWED_ADMINS)
    
    if not group or (group['owner_id'] != current_user['id'] and not is_admin):
        raise HTTPException(status_code=403, detail="无权操作")
        
    safe_name = sanitize_plain_text(data.name, 64)
    if not safe_name:
        raise HTTPException(status_code=400, detail="群聊名称不能为空")
    db.execute("UPDATE groups SET name=? WHERE id=?", (safe_name, group_id))
    db.commit()
    return {"status": "success"}

@router.put("/groups/{group_id}/permissions")
async def update_group_permissions(
    group_id: int, 
    data: GroupPermissionUpdate, 
    current_user = Depends(get_current_user), 
    db = Depends(get_db)
):
    if group_id == 0:
        raise HTTPException(status_code=403, detail="公共大厅不可修改权限")
        
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    is_admin = current_user['role'] == 1 or (current_user['username'] in Config.ALLOWED_ADMINS)
    
    if not group or (group['owner_id'] != current_user['id'] and not is_admin):
        raise HTTPException(status_code=403, detail="仅群主或管理员可设置权限")
        
    db.execute("""
        UPDATE groups 
        SET view_mode=?, speak_mode=?, black_view=?, black_speak=?, white_view=?, white_speak=? 
        WHERE id=?
    """, (data.view_mode, data.speak_mode, data.black_view, data.black_speak, data.white_view, data.white_speak, group_id))
    db.commit()
    return {"status": "success"}

@router.post("/groups/{group_id}/avatar")
async def update_group_avatar(
    group_id: int, 
    data: GroupAvatarUpdate, 
    current_user = Depends(get_current_user), 
    db = Depends(get_db)
):
    if group_id == 0:
        raise HTTPException(status_code=403, detail="不可修改")
        
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    is_admin = current_user['role'] == 1 or (current_user['username'] in Config.ALLOWED_ADMINS)
    
    if not group or (group['owner_id'] != current_user['id'] and not is_admin):
        raise HTTPException(status_code=403, detail="无权")
        
    try:
        avatar = normalize_avatar(data.avatar)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.execute("UPDATE groups SET avatar=? WHERE id=?", (avatar, group_id))
    db.commit()
    return {"status": "success"}

@router.delete("/groups/{group_id}")
async def delete_group(group_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    if group_id == 0:
        raise HTTPException(status_code=403, detail="不可解散")
        
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    is_admin = current_user['role'] == 1 or (current_user['username'] in Config.ALLOWED_ADMINS)
    
    if not group or (group['owner_id'] != current_user['id'] and not is_admin):
        raise HTTPException(status_code=403, detail="无权")
        
    db.execute("DELETE FROM groups WHERE id=?", (group_id,))
    db.execute("DELETE FROM messages WHERE room_id=?", (group_id,))
    db.execute("DELETE FROM group_members WHERE group_id=?", (group_id,))
    db.execute("DELETE FROM group_join_requests WHERE group_id=?", (group_id,))
    db.execute("DELETE FROM group_invites WHERE group_id=?", (group_id,))
    db.execute("DELETE FROM group_audit_logs WHERE group_id=?", (group_id,))
    db.commit()
    return {"status": "success"}


@router.get("/groups/discover")
async def discover_groups(current_user = Depends(get_current_user), db = Depends(get_db)):
    rows = db.execute(
        """
        SELECT g.id, g.name, g.avatar, g.announcement, g.member_only, g.join_approval,
               EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.username=?) AS is_member,
               COALESCE((SELECT status FROM group_join_requests r WHERE r.group_id=g.id AND r.username=?), '') AS request_status
        FROM groups g WHERE g.id>0 AND g.is_public=1 ORDER BY g.id DESC
        """,
        (current_user['username'], current_user['username']),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.put("/groups/{group_id}/advanced")
async def update_group_advanced(
    group_id: int,
    data: GroupAdvancedUpdate,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    require_group_manager(group_id, current_user, db)
    announcement = sanitize_plain_text(data.announcement, 2000)
    db.execute(
        "UPDATE groups SET announcement=?, member_only=?, join_approval=? WHERE id=?",
        (announcement, int(data.member_only), int(data.join_approval), group_id),
    )
    audit_group(db, group_id, current_user['username'], 'update_settings', detail=announcement[:200])
    db.commit()
    return {"status": "success"}


@router.get("/groups/{group_id}/members")
async def get_group_members(group_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or not can_view_group(
        group, current_user['username'], current_user['id'], current_user['role'], db
    ):
        raise HTTPException(status_code=403, detail="无权查看群成员")
    rows = db.execute(
        """
        SELECT gm.username, COALESCE(u.nickname, gm.username) AS nickname, u.avatar,
               gm.member_role, gm.muted_until, gm.joined_at
        FROM group_members gm LEFT JOIN users u ON u.username=gm.username
        WHERE gm.group_id=? ORDER BY CASE gm.member_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at
        """,
        (group_id,),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.post("/groups/{group_id}/join")
async def request_group_join(group_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group or group_id == 0 or not group['is_public']:
        raise HTTPException(status_code=404, detail="群聊不存在或不可申请")
    member = db.execute(
        "SELECT 1 FROM group_members WHERE group_id=? AND username=?",
        (group_id, current_user['username']),
    ).fetchone()
    if member:
        return {"status": "success", "joined": True}
    if group['join_approval']:
        db.execute(
            """
            INSERT INTO group_join_requests (group_id, username, status) VALUES (?, ?, 'pending')
            ON CONFLICT(group_id, username) DO UPDATE SET status='pending', updated_at=CURRENT_TIMESTAMP
            """,
            (group_id, current_user['username']),
        )
        audit_group(db, group_id, current_user['username'], 'request_join')
        joined = False
    else:
        db.execute(
            "INSERT OR IGNORE INTO group_members (group_id, username) VALUES (?, ?)",
            (group_id, current_user['username']),
        )
        audit_group(db, group_id, current_user['username'], 'join_group')
        joined = True
    db.commit()
    return {"status": "success", "joined": joined, "pending": not joined}


@router.get("/groups/{group_id}/join-requests")
async def get_group_join_requests(group_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    require_group_manager(group_id, current_user, db)
    rows = db.execute(
        """
        SELECT r.username, COALESCE(u.nickname, r.username) AS nickname, u.avatar, r.created_at
        FROM group_join_requests r LEFT JOIN users u ON u.username=r.username
        WHERE r.group_id=? AND r.status='pending' ORDER BY r.id
        """,
        (group_id,),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.post("/groups/{group_id}/join-requests/respond")
async def respond_group_join_request(
    group_id: int,
    data: GroupRequestActionData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    require_group_manager(group_id, current_user, db)
    request_row = db.execute(
        "SELECT * FROM group_join_requests WHERE group_id=? AND username=? AND status='pending'",
        (group_id, data.username),
    ).fetchone()
    if not request_row:
        raise HTTPException(status_code=404, detail="申请不存在")
    if data.action == 'accept':
        db.execute(
            "INSERT OR IGNORE INTO group_members (group_id, username) VALUES (?, ?)",
            (group_id, data.username),
        )
    db.execute(
        "UPDATE group_join_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ('accepted' if data.action == 'accept' else 'rejected', request_row['id']),
    )
    audit_group(db, group_id, current_user['username'], f"{data.action}_join", data.username)
    db.execute(
        "INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)",
        (f"您的群聊申请已被{'同意' if data.action == 'accept' else '拒绝'}", current_user['username'], data.username),
    )
    db.commit()
    return {"status": "success"}


@router.post("/groups/{group_id}/invite")
async def invite_group_member(
    group_id: int,
    data: GroupInviteData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    member = db.execute(
        "SELECT 1 FROM group_members WHERE group_id=? AND username=?",
        (group_id, current_user['username']),
    ).fetchone()
    if not group or (not member and group['owner_id'] != current_user['id'] and current_user['role'] != 1):
        raise HTTPException(status_code=403, detail="只有群成员可以邀请")
    if not db.execute("SELECT 1 FROM users WHERE username=?", (data.username,)).fetchone():
        raise HTTPException(status_code=404, detail="用户不存在")
    if db.execute(
        "SELECT 1 FROM group_members WHERE group_id=? AND username=?", (group_id, data.username)
    ).fetchone():
        raise HTTPException(status_code=409, detail="该用户已在群内")
    db.execute(
        """
        INSERT INTO group_invites (group_id, inviter, invitee, status) VALUES (?, ?, ?, 'pending')
        ON CONFLICT(group_id, invitee) DO UPDATE SET inviter=excluded.inviter, status='pending', updated_at=CURRENT_TIMESTAMP
        """,
        (group_id, current_user['username'], data.username),
    )
    db.execute(
        "INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)",
        (f"邀请您加入群聊：{group['name']}", current_user['username'], data.username),
    )
    audit_group(db, group_id, current_user['username'], 'invite_member', data.username)
    db.commit()
    return {"status": "success"}


@router.get("/group-invites")
async def get_group_invites(current_user = Depends(get_current_user), db = Depends(get_db)):
    rows = db.execute(
        """
        SELECT i.id, i.group_id, i.inviter, i.created_at, g.name AS group_name, g.avatar
        FROM group_invites i JOIN groups g ON g.id=i.group_id
        WHERE i.invitee=? AND i.status='pending' ORDER BY i.id DESC
        """,
        (current_user['username'],),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}


@router.post("/group-invites/respond")
async def respond_group_invite(
    data: GroupInviteActionData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    invite = db.execute(
        "SELECT * FROM group_invites WHERE id=? AND invitee=? AND status='pending'",
        (data.invite_id, current_user['username']),
    ).fetchone()
    if not invite:
        raise HTTPException(status_code=404, detail="邀请不存在")
    if data.action == 'accept':
        db.execute(
            "INSERT OR IGNORE INTO group_members (group_id, username) VALUES (?, ?)",
            (invite['group_id'], current_user['username']),
        )
    db.execute(
        "UPDATE group_invites SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ('accepted' if data.action == 'accept' else 'rejected', invite['id']),
    )
    audit_group(db, invite['group_id'], current_user['username'], f"{data.action}_invite")
    db.commit()
    return {"status": "success"}


@router.put("/groups/{group_id}/members/{username}")
async def update_group_member(
    group_id: int,
    username: str,
    data: GroupMemberUpdateData,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    group = require_group_manager(group_id, current_user, db)
    member = db.execute(
        "SELECT * FROM group_members WHERE group_id=? AND username=?", (group_id, username)
    ).fetchone()
    if not member:
        raise HTTPException(status_code=404, detail="群成员不存在")
    owner = db.execute("SELECT username FROM users WHERE id=?", (group['owner_id'],)).fetchone()
    if owner and owner['username'] == username:
        raise HTTPException(status_code=403, detail="不能修改群主")
    muted_until = data.muted_until
    if muted_until:
        try:
            datetime.datetime.fromisoformat(muted_until.replace('Z', '+00:00'))
        except ValueError:
            raise HTTPException(status_code=400, detail="禁言时间格式无效")
    db.execute(
        "UPDATE group_members SET member_role=COALESCE(?, member_role), muted_until=? WHERE group_id=? AND username=?",
        (data.role, muted_until, group_id, username),
    )
    audit_group(db, group_id, current_user['username'], 'update_member', username, f"role={data.role}, muted_until={muted_until}")
    db.commit()
    return {"status": "success"}


@router.delete("/groups/{group_id}/members/{username}")
async def remove_group_member(
    group_id: int,
    username: str,
    current_user = Depends(get_current_user),
    db = Depends(get_db),
):
    group = require_group_manager(group_id, current_user, db)
    owner = db.execute("SELECT username FROM users WHERE id=?", (group['owner_id'],)).fetchone()
    if owner and owner['username'] == username:
        raise HTTPException(status_code=403, detail="不能移除群主")
    db.execute("DELETE FROM group_members WHERE group_id=? AND username=?", (group_id, username))
    audit_group(db, group_id, current_user['username'], 'remove_member', username)
    db.commit()
    return {"status": "success"}


@router.get("/groups/{group_id}/audit")
async def get_group_audit(group_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
    require_group_manager(group_id, current_user, db)
    rows = db.execute(
        "SELECT * FROM group_audit_logs WHERE group_id=? ORDER BY id DESC LIMIT 200",
        (group_id,),
    ).fetchall()
    return {"status": "success", "data": [dict(row) for row in rows]}
