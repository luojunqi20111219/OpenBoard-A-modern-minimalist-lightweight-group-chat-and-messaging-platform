from fastapi import APIRouter, Depends, HTTPException, Request
from werkzeug.security import generate_password_hash
from app.config import Config
from app.database import get_db
from app.models import AdminAction, MessageData
from app.auth import get_current_admin
from app.routes.auth import delete_user_and_data

router = APIRouter(prefix="/api")

@router.post("/admin/toggle_freeze_group")
async def admin_toggle_freeze_group(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    if data.group_id == 0:
        return {"status": "error", "msg": "公共大厅受保护"}
        
    group = db.execute("SELECT is_frozen FROM groups WHERE id=?", (data.group_id,)).fetchone()
    if not group:
        raise HTTPException(status_code=444, detail="群聊未找到")
        
    new_status = 0 if group['is_frozen'] else 1
    db.execute("UPDATE groups SET is_frozen=? WHERE id=?", (new_status, data.group_id))
    db.commit()
    return {"status": "success", "msg": "已冻结" if new_status else "已解冻"}

@router.post("/admin/update_user_avatar")
async def admin_update_user_avatar(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    db.execute("UPDATE users SET avatar=? WHERE id=?", (data.avatar_base64, data.user_id))
    db.commit()
    return {"status": "success", "msg": "头像已强行修改"}

@router.post("/admin/update_group_avatar")
async def admin_update_group_avatar(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    db.execute("UPDATE groups SET avatar=? WHERE id=?", (data.avatar_base64, data.group_id))
    db.commit()
    return {"status": "success", "msg": "群头像已强行修改"}

@router.post("/admin/delete_user")
async def admin_delete_user(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    target = db.execute("SELECT * FROM users WHERE id=?", (data.user_id,)).fetchone()
    if not target or target['username'] in ["admin", "官方账号"]:
        raise HTTPException(status_code=403, detail="系统保护账号不可删除")
        
    delete_user_and_data(db, target['id'], target['username'])
    db.commit()
    return {"status": "success"}

@router.post("/admin/reset_password")
async def admin_reset_password(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    db.execute(
        "UPDATE users SET password_hash=? WHERE id=?", 
        (generate_password_hash(data.new_password), data.user_id)
    )
    db.commit()
    return {"status": "success"}

@router.post("/admin/delete_group")
async def admin_delete_group(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    if data.group_id == 0:
        raise HTTPException(status_code=403, detail="公共大厅不可修改")
        
    db.execute("DELETE FROM groups WHERE id=?", (data.group_id,))
    db.execute("DELETE FROM messages WHERE room_id=?", (data.group_id,))
    db.commit()
    return {"status": "success"}

@router.post("/admin/delete_groups")
async def admin_delete_groups(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    if not data.group_ids:
        return {"status": "success", "msg": "未选中任何群聊"}
        
    safe_group_ids = [gid for gid in data.group_ids if gid != 0]
    if not safe_group_ids:
        return {"status": "success", "msg": "公共大厅受保护"}
        
    placeholders = ', '.join(['?'] * len(safe_group_ids))
    db.execute(f"DELETE FROM groups WHERE id IN ({placeholders})", safe_group_ids)
    db.execute(f"DELETE FROM messages WHERE room_id IN ({placeholders})", safe_group_ids)
    db.commit()
    return {"status": "success", "msg": "批量删除选中群组成功"}

@router.post("/delete_messages")
async def delete_messages(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    if not data.msg_ids:
        return {"status": "success", "msg": "未选中任何留言"}
        
    placeholders = ', '.join(['?'] * len(data.msg_ids))
    db.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", data.msg_ids)
    db.commit()
    return {"status": "success"}

@router.post("/toggle_ban_user")
async def toggle_ban(
    data: AdminAction, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    user = db.execute("SELECT username, is_banned FROM users WHERE id=?", (data.user_id,)).fetchone()
    if user:
        if user['username'] in ["admin", "官方账号"]:
            return {"status": "error", "msg": "保护账号不可封禁"}
            
        new_status = 0 if user['is_banned'] else 1
        db.execute("UPDATE users SET is_banned=? WHERE id=?", (new_status, data.user_id))
        
        # If user is banned, also revoke their active sessions (legacy fallback token clearing)
        if new_status == 1:
            db.execute("UPDATE users SET token=NULL WHERE id=?", (data.user_id,))
            
        db.commit()
        return {"status": "success", "msg": "已封禁" if new_status else "已解封"}
        
    return {"status": "error", "msg": "用户未找到"}

@router.post("/admin/broadcast")
async def admin_broadcast(
    data: MessageData, 
    db = Depends(get_db), 
    current_admin = Depends(get_current_admin)
):
    db.execute("INSERT INTO notifications (content, sender) VALUES (?, ?)", (data.content, "系统"))
    db.commit()
    return {"status": "success"}
