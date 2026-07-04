import os
import json
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from app.config import Config
from app.database import patch_db, get_db, get_db_ctx
from app.auth import verify_token
from app.websocket import manager
from app.routes import auth, messages, groups, admin, friends

# Run database setup & seeding
patch_db()

app = FastAPI(title="信语 (OpenBoard)", version=Config.CURRENT_VERSION)
templates = Jinja2Templates(directory="templates")

# Mount Uploads directory for static access
app.mount("/uploads", StaticFiles(directory=Config.UPLOAD_DIR), name="uploads")

# Include Modular API Routers
app.include_router(auth.router)
app.include_router(messages.router)
app.include_router(groups.router)
app.include_router(admin.router)
app.include_router(friends.router)

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    if os.path.exists("favicon.ico"):
        return FileResponse("favicon.ico")
    return FileResponse("favicon.ico")  # Safe fallback or raise 404

@app.get("/", response_class=HTMLResponse)
async def home_page(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={"request": request})

@app.get("/admin", response_class=HTMLResponse)
async def admin_dashboard(request: Request, db = Depends(get_db)):
    # Retrieve Cookie-based JWT token
    token = request.cookies.get("token")
    if not token:
        # Redirect unauthorized clients to home page safely
        return RedirectResponse(url="/?error=unauthorized", status_code=303)
        
    user = verify_token(token, db)
    if not user or (user['role'] != 1 and user['username'] not in Config.ALLOWED_ADMINS):
        return RedirectResponse(url="/?error=unauthorized_admin", status_code=303)
        
    # Render sensitive lists server-side safely only for verified administrators
    messages = db.execute("SELECT * FROM messages ORDER BY id DESC").fetchall()
    users = db.execute("SELECT * FROM users ORDER BY id DESC").fetchall()
    groups = db.execute("SELECT * FROM groups ORDER BY id DESC").fetchall()
    
    return templates.TemplateResponse(
        request=request,
        name="admin.html", 
        context={
            "request": request, 
            "messages": messages, 
            "users": users, 
            "groups": groups
        }
    )

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    # Decode token inside context manager to instantly release DB connection
    with get_db_ctx() as db:
        user = verify_token(token, db)
        if not user:
            await websocket.close(code=1008)
            return
        username = user['username']

    await manager.connect(websocket, username)
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message.get("type") == "typing":
                await manager.broadcast({
                    "type": "typing",
                    "user": username,
                    "room_id": message.get("room_id"),
                    "receiver": message.get("receiver")
                }, room_id=message.get("room_id"), receiver=message.get("receiver"), sender=username)
    except WebSocketDisconnect:
        manager.disconnect(websocket, username)
        await manager.broadcast_online_status()
    except Exception:
        manager.disconnect(websocket, username)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=5000, reload=True)
