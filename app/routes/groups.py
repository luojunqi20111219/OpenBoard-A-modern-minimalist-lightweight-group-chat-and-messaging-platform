from fastapi import APIRouter, Depends, HTTPException, Request
from app.config import Config
from app.database import get_db
from app.models import GroupCreate, GroupUpdate, GroupPermissionUpdate, GroupAvatarUpdate
from app.auth import get_current_user, verify_token

router = APIRouter(prefix="/api")

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
            
        can_view = True
        is_owner = username and g['owner_id'] == user_id
        is_admin = user_role == 1 or (username in Config.ALLOWED_ADMINS)
        
        if not is_owner and not is_admin:
            if g['view_mode'] == 1:
                w_list = [u.strip() for u in (g['white_view'] or '').split(',') if u.strip()]
                if not username or username not in w_list:
                    can_view = False
            else:
                b_list = [u.strip() for u in (g['black_view'] or '').split(',') if u.strip()]
                if username and username in b_list:
                    can_view = False
                    
        if can_view:
            result.append(dict(g))
            
    return {"status": "success", "data": result}

@router.post("/groups")
async def create_group(data: GroupCreate, current_user = Depends(get_current_user), db = Depends(get_db)):
    cursor = db.execute(
        "INSERT INTO groups (name, is_public, owner_id) VALUES (?, ?, ?)", 
        (data.name, data.is_public, current_user['id'])
    )
    db.commit()
    return {"status": "success", "group_id": cursor.lastrowid}

@router.put("/groups/{group_id}")
async def update_group(group_id: int, data: GroupUpdate, current_user = Depends(get_current_user), db = Depends(get_db)):
    if group_id == 0:
        raise HTTPException(status_code=403, detail="公共大厅不可修改")
        
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    is_admin = current_user['role'] == 1 or (current_user['username'] in Config.ALLOWED_ADMINS)
    
    if not group or (group['owner_id'] != current_user['id'] and not is_admin):
        raise HTTPException(status_code=403, detail="无权操作")
        
    db.execute("UPDATE groups SET name=? WHERE id=?", (data.name, group_id))
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
        
    db.execute("UPDATE groups SET avatar=? WHERE id=?", (data.avatar, group_id))
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
    db.commit()
    return {"status": "success"}
