import json
from fastapi import WebSocket
from typing import Dict, List

class ConnectionManager:
    def __init__(self):
        # active_connections: { username: [websocket1, websocket2] }
        self.active_connections: Dict[str, List[WebSocket]] = {}
        # typing_users: { room_id_or_receiver: { username: timestamp } }
        self.typing_users: Dict[str, Dict[str, float]] = {}

    async def connect(self, websocket: WebSocket, username: str):
        await websocket.accept()
        if username not in self.active_connections:
            self.active_connections[username] = []
        self.active_connections[username].append(websocket)
        await self.broadcast_online_status()

    def disconnect(self, websocket: WebSocket, username: str):
        if username in self.active_connections:
            if websocket in self.active_connections[username]:
                self.active_connections[username].remove(websocket)
            if not self.active_connections[username]:
                del self.active_connections[username]
        
    async def broadcast_online_status(self):
        online_users = list(self.active_connections.keys())
        await self.broadcast({"type": "online_status", "users": online_users})

    async def broadcast(self, message: dict, room_id: int = None, receiver: str = None, sender: str = None):
        """
        Broadcasting message logic:
        1. If receiver is defined (private chat), broadcast only to sender and receiver active connections.
        2. Otherwise (public room or group), broadcast to all online active connections.
        """
        payload = json.dumps(message)
        
        if receiver:
            targets = [sender, receiver] if sender else [receiver]
            for user in targets:
                if user in self.active_connections:
                    for ws in self.active_connections[user]:
                        try:
                            await ws.send_text(payload)
                        except Exception:
                            pass
        else:
            for user_ws_list in list(self.active_connections.values()):
                for ws in user_ws_list:
                    try:
                        await ws.send_text(payload)
                    except Exception:
                        pass

    async def send_personal(self, message: dict, username: str):
        """Send a message to all active connections of a specific user"""
        payload = json.dumps(message)
        if username in self.active_connections:
            for ws in self.active_connections[username]:
                try:
                    await ws.send_text(payload)
                except Exception:
                    pass

manager = ConnectionManager()

