import json
import asyncio
from fastapi import WebSocket
from typing import Dict, List

class ConnectionManager:
    MAX_CONNECTIONS_PER_USER = 4

    def __init__(self):
        # active_connections: { username: [websocket1, websocket2] }
        self.active_connections: Dict[str, List[WebSocket]] = {}
        # typing_users: { room_id_or_receiver: { username: timestamp } }
        self.typing_users: Dict[str, Dict[str, float]] = {}

    async def connect(self, websocket: WebSocket, username: str):
        await websocket.accept()
        if username not in self.active_connections:
            self.active_connections[username] = []
        while len(self.active_connections[username]) >= self.MAX_CONNECTIONS_PER_USER:
            old_connection = self.active_connections[username].pop(0)
            try:
                await old_connection.close(code=1013)
            except Exception:
                pass
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
        
        async def send_safe(username: str, ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=5)
                return username, ws, True
            except Exception:
                return username, ws, False

        recipients = []
        if receiver:
            targets = [sender, receiver] if sender else [receiver]
            for user in targets:
                if user in self.active_connections:
                    for ws in self.active_connections[user]:
                        recipients.append((user, ws))
        else:
            for username, user_ws_list in list(self.active_connections.items()):
                for ws in user_ws_list:
                    recipients.append((username, ws))

        if recipients:
            results = await asyncio.gather(
                *(send_safe(username, ws) for username, ws in recipients),
                return_exceptions=True,
            )
            for result in results:
                if isinstance(result, tuple):
                    username, ws, delivered = result
                    if not delivered:
                        self.disconnect(ws, username)

    async def send_personal(self, message: dict, username: str):
        """Send a message to all active connections of a specific user"""
        payload = json.dumps(message)
        async def send_safe(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=5)
            except Exception:
                self.disconnect(ws, username)
        if username in self.active_connections:
            await asyncio.gather(
                *(send_safe(ws) for ws in list(self.active_connections[username])),
                return_exceptions=True,
            )

    async def close_user_connections(self, username: str):
        connections = self.active_connections.pop(username, [])
        if connections:
            await asyncio.gather(
                *(ws.close(code=4001) for ws in connections),
                return_exceptions=True,
            )
            await self.broadcast_online_status()

manager = ConnectionManager()
