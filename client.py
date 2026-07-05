import os
import sys
import json
import time
import base64
import io
import threading
import queue
import requests
import asyncio
import websockets
import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageTk
import customtkinter as ctk

# Set appearance mode and color theme
ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")

class NativeClient(ctk.CTk):
    def __init__(self):
        super().__init__()
        
        self.title("信语 ROOT 系统 - 原生Windows客户端 v6.0")
        self.geometry("950x650")
        self.minsize(800, 550)
        
        # Connection and auth state
        self.server_url = "http://47.93.6.111:5000"
        self.ws_url = "ws://47.93.6.111:5000"
        self.token = None
        self.current_user = None
        self.current_nickname = None
        self.user_role = 2
        
        # Chat state
        self.current_room_id = 0
        self.current_target_user = None
        self.current_target_name = "公共大厅"
        self.friends = []
        self.groups = []
        self.messages_list = []
        
        # Thread safe message queue
        self.ui_queue = queue.Queue()
        
        # Background task controls
        self.ws_thread = None
        self.ws_loop = None
        self.stop_ws = False
        
        # Image Cache
        self.image_cache = {}
        self.avatar_cache = {}
        
        # Build UI layout
        self.show_login_frame()
        self.poll_queue()
        
    def poll_queue(self):
        """Periodically check queue for UI updates from background threads"""
        try:
            while True:
                msg = self.ui_queue.get_nowait()
                cmd = msg.get("cmd")
                if cmd == "new_message":
                    self.append_message_to_ui(msg["data"])
                elif cmd == "toast":
                    messagebox.showinfo("提示", msg["text"])
                elif cmd == "error":
                    messagebox.showerror("错误", msg["text"])
                elif cmd == "typing":
                    self.show_typing_indicator(msg["user"])
                elif cmd == "online_status":
                    self.update_online_status(msg["users"])
                self.ui_queue.task_done()
        except queue.Empty:
            pass
        self.after(100, self.poll_queue)

    def show_login_frame(self):
        # Clear existing frames
        for child in self.winfo_children():
            child.destroy()
            
        self.login_frame = ctk.CTkFrame(self, width=400, height=500, corner_radius=20)
        self.login_frame.place(relx=0.5, rely=0.5, anchor=tk.CENTER)
        
        title_label = ctk.CTkLabel(self.login_frame, text="🛡️ 信语 ROOT 系统", font=ctk.CTkFont(size=24, weight="bold"))
        title_label.pack(pady=(40, 10))
        
        subtitle_label = ctk.CTkLabel(self.login_frame, text="原生 Windows 客户端 v6.0", font=ctk.CTkFont(size=13))
        subtitle_label.pack(pady=(0, 30))
        
        self.srv_entry = ctk.CTkEntry(self.login_frame, width=280, placeholder_text="服务器地址", value=self.server_url)
        self.srv_entry.insert(0, self.server_url)
        self.srv_entry.pack(pady=10)
        
        self.usr_entry = ctk.CTkEntry(self.login_frame, width=280, placeholder_text="用户名 / 账号")
        self.usr_entry.pack(pady=10)
        
        self.pwd_entry = ctk.CTkEntry(self.login_frame, width=280, placeholder_text="密码", show="*")
        self.pwd_entry.pack(pady=10)
        
        # Nickname field for Register mode
        self.nick_entry = ctk.CTkEntry(self.login_frame, width=280, placeholder_text="昵称 (仅注册时需要)")
        self.nick_entry.pack(pady=10)
        
        btn_login = ctk.CTkButton(self.login_frame, width=280, text="登录", font=ctk.CTkFont(weight="bold"), command=self.handle_login)
        btn_login.pack(pady=(20, 10))
        
        btn_register = ctk.CTkButton(self.login_frame, width=280, text="注册账号", fg_color="transparent", border_width=1, hover_color="#2B2B2B", command=self.handle_register)
        btn_register.pack(pady=10)

    def handle_login(self):
        srv = self.srv_entry.get().strip()
        usr = self.usr_entry.get().strip()
        pwd = self.pwd_entry.get().strip()
        
        if not srv or not usr or not pwd:
            messagebox.showerror("错误", "请填写服务器地址、用户名及密码！")
            return
            
        self.server_url = srv
        if srv.startswith("https"):
            self.ws_url = srv.replace("https://", "wss://")
        else:
            self.ws_url = srv.replace("http://", "ws://")
            
        threading.Thread(target=self._async_login, args=(usr, pwd), daemon=True).start()

    def _async_login(self, username, password):
        try:
            r = requests.post(f"{self.server_url}/api/login", json={
                "username": username,
                "password": password
            }, timeout=8)
            
            if r.status_code == 200:
                data = r.json()
                self.token = data.get("token")
                self.current_user = data.get("username")
                self.current_nickname = data.get("nickname") or self.current_user
                self.user_role = data.get("role", 2)
                
                # Start websocket connection
                self.start_websocket()
                
                self.ui_queue.put({"cmd": "toast", "text": f"欢迎回来，{self.current_nickname}！"})
                self.after(100, self.show_main_chat_frame)
            elif r.status_code == 401:
                self.ui_queue.put({"cmd": "error", "text": "用户名或密码错误！"})
            else:
                self.ui_queue.put({"cmd": "error", "text": f"登录失败: {r.status_code}"})
        except Exception as e:
            self.ui_queue.put({"cmd": "error", "text": f"无法连接到服务器:\n{str(e)}"})

    def handle_register(self):
        srv = self.srv_entry.get().strip()
        usr = self.usr_entry.get().strip()
        pwd = self.pwd_entry.get().strip()
        nick = self.nick_entry.get().strip()
        
        if not srv or not usr or not pwd:
            messagebox.showerror("错误", "请填写服务器地址、用户名及密码！")
            return
            
        self.server_url = srv
        threading.Thread(target=self._async_register, args=(usr, pwd, nick), daemon=True).start()

    def _async_register(self, username, password, nickname):
        try:
            r = requests.post(f"{self.server_url}/api/register", json={
                "username": username,
                "password": password,
                "nickname": nickname if nickname else username
            }, timeout=8)
            
            if r.status_code == 200:
                self.ui_queue.put({"cmd": "toast", "text": "注册成功，请直接登录！"})
            else:
                data = r.json()
                self.ui_queue.put({"cmd": "error", "text": f"注册失败: {data.get('detail', '未知错误')}"})
        except Exception as e:
            self.ui_queue.put({"cmd": "error", "text": f"无法连接至服务器:\n{str(e)}"})

    # --- Websocket System ---
    def start_websocket(self):
        self.stop_ws = False
        self.ws_thread = threading.Thread(target=self._ws_run_loop, daemon=True)
        self.ws_thread.start()

    def _ws_run_loop(self):
        self.ws_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.ws_loop)
        self.ws_loop.run_until_complete(self._ws_handler())

    async def _ws_handler(self):
        uri = f"{self.ws_url}/ws/{self.token}"
        while not self.stop_ws:
            try:
                async with websockets.connect(uri) as websocket:
                    while not self.stop_ws:
                        raw_data = await websocket.recv()
                        data = json.loads(raw_data)
                        
                        msg_type = data.get("type")
                        if msg_type == "message":
                            self.ui_queue.put({"cmd": "new_message", "data": data})
                        elif msg_type == "online_status":
                            self.ui_queue.put({"cmd": "online_status", "users": data.get("users", [])})
                        elif msg_type == "typing":
                            self.ui_queue.put({"cmd": "typing", "user": data.get("user")})
            except Exception as e:
                print(f"WS Connection lost, retrying in 3s... Error: {e}")
                await asyncio.sleep(3)

    # --- UI Layout Design ---
    def show_main_chat_frame(self):
        for child in self.winfo_children():
            child.destroy()
            
        # Left Panel (Sidebar)
        self.sidebar_frame = ctk.CTkFrame(self, width=280, corner_radius=0)
        self.sidebar_frame.pack(side=tk.LEFT, fill=tk.Y)
        
        # User details card
        self.user_card = ctk.CTkFrame(self.sidebar_frame, height=80, corner_radius=10, fg_color=("white", "#2B2B2B"))
        self.user_card.pack(fill=tk.X, padx=15, pady=15)
        
        self.lbl_my_nick = ctk.CTkLabel(self.user_card, text=self.current_nickname, font=ctk.CTkFont(size=15, weight="bold"))
        self.lbl_my_nick.pack(anchor="w", padx=15, pady=(15, 2))
        
        self.lbl_my_name = ctk.CTkLabel(self.user_card, text=f"@{self.current_user}", font=ctk.CTkFont(size=11), text_color="gray")
        self.lbl_my_name.pack(anchor="w", padx=15, pady=(0, 15))
        
        # Category Tabs
        self.sidebar_tabs = ctk.CTkTabview(self.sidebar_frame, height=350)
        self.sidebar_tabs.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        
        self.tab_chats = self.sidebar_tabs.add("会话列表")
        self.tab_contacts = self.sidebar_tabs.add("联系人")
        
        # Scrollable session list
        self.chats_scroll = ctk.CTkScrollableFrame(self.tab_chats, fg_color="transparent")
        self.chats_scroll.pack(fill=tk.BOTH, expand=True)
        
        # Scrollable contact list
        self.contacts_scroll = ctk.CTkScrollableFrame(self.tab_contacts, fg_color="transparent")
        self.contacts_scroll.pack(fill=tk.BOTH, expand=True)
        
        # Operations buttons at the bottom of sidebar
        self.ops_frame = ctk.CTkFrame(self.sidebar_frame, fg_color="transparent")
        self.ops_frame.pack(fill=tk.X, side=tk.BOTTOM, padx=15, pady=15)
        
        btn_search = ctk.CTkButton(self.ops_frame, text="添加好友 / 创建群", height=32, command=self.show_search_add_dialog)
        btn_search.pack(fill=tk.X, pady=5)
        
        btn_logout = ctk.CTkButton(self.ops_frame, text="退出登录", fg_color="#E53935", hover_color="#D32F2F", height=32, command=self.handle_logout)
        btn_logout.pack(fill=tk.X, pady=5)
        
        # Right Panel (Chat Pane)
        self.chat_pane = ctk.CTkFrame(self, corner_radius=0, fg_color=("gray95", "gray10"))
        self.chat_pane.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)
        
        # Chat Header
        self.chat_header = ctk.CTkFrame(self.chat_pane, height=60, corner_radius=0, fg_color=("white", "#1e1e1e"))
        self.chat_header.pack(fill=tk.X)
        
        self.lbl_chat_title = ctk.CTkLabel(self.chat_header, text=self.current_target_name, font=ctk.CTkFont(size=16, weight="bold"))
        self.lbl_chat_title.pack(side=tk.LEFT, padx=20, pady=15)
        
        self.lbl_typing = ctk.CTkLabel(self.chat_header, text="", font=ctk.CTkFont(size=12), text_color="green")
        self.lbl_typing.pack(side=tk.LEFT, padx=10, pady=15)
        
        # Chat history scroll area
        self.chat_scroll = ctk.CTkScrollableFrame(self.chat_pane, fg_color="transparent")
        self.chat_scroll.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # Bottom Input Area
        self.input_area = ctk.CTkFrame(self.chat_pane, height=70, corner_radius=15, fg_color=("white", "#1e1e1e"))
        self.input_area.pack(fill=tk.X, padx=15, pady=15)
        
        # Attachments menu button
        self.btn_attach = ctk.CTkButton(self.input_area, text="📎", width=40, height=40, font=ctk.CTkFont(size=18), fg_color="transparent", text_color="gray", hover_color=("#E5E5E5", "#2B2B2B"), command=self.show_attachment_options)
        self.btn_attach.pack(side=tk.LEFT, padx=(10, 5), pady=10)
        
        self.entry_message = ctk.CTkEntry(self.input_area, placeholder_text="输入消息...", height=40, border_width=0, fg_color="transparent")
        self.entry_message.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5, pady=10)
        self.entry_message.bind("<Return>", lambda e: self.send_message())
        
        self.btn_send = ctk.CTkButton(self.input_area, text="发送", width=70, height=40, font=ctk.CTkFont(weight="bold"), command=self.send_message)
        self.btn_send.pack(side=tk.RIGHT, padx=(5, 10), pady=10)
        
        # Populate initial lists
        self.load_friends_and_groups()

    def handle_logout(self):
        self.stop_ws = True
        self.token = None
        self.current_user = None
        self.show_login_frame()

    # --- Loading Friends & Groups ---
    def load_friends_and_groups(self):
        threading.Thread(target=self._async_load_relations, daemon=True).start()

    def _async_load_relations(self):
        headers = {"Authorization": self.token}
        
        # 1. Load Friends
        try:
            r = requests.get(f"{self.server_url}/api/friends", headers=headers, timeout=5)
            if r.status_code == 200:
                self.friends = r.json().get("data", [])
        except Exception as e:
            print(f"Failed to fetch friends: {e}")
            
        # 2. Load Groups
        try:
            r = requests.get(f"{self.server_url}/api/groups", headers=headers, timeout=5)
            if r.status_code == 200:
                self.groups = r.json()
        except Exception as e:
            print(f"Failed to fetch groups: {e}")
            
        # Populate GUI items on main thread
        self.after(100, self.render_relations_list)

    def render_relations_list(self):
        # Clear sidebar elements
        for child in self.chats_scroll.winfo_children():
            child.destroy()
        for child in self.contacts_scroll.winfo_children():
            child.destroy()
            
        # Add Public Lobby shortcut
        lobby_btn = ctk.CTkButton(
            self.chats_scroll,
            text="💬 公共大厅",
            anchor="w",
            fg_color="transparent",
            text_color=("black", "white"),
            hover_color=("#E5E5E5", "#2B2B2B"),
            command=lambda: self.switch_chat(0, None, "公共大厅")
        )
        lobby_btn.pack(fill=tk.X, pady=2)
        
        # Add groups to会话列表
        for g in self.groups:
            gid = g.get("id")
            gname = g.get("name")
            owner_suffix = " 👑" if g.get("owner") == self.current_user else ""
            btn = ctk.CTkButton(
                self.chats_scroll,
                text=f"👥 {gname}{owner_suffix}",
                anchor="w",
                fg_color="transparent",
                text_color=("black", "white"),
                hover_color=("#E5E5E5", "#2B2B2B"),
                command=lambda id_=gid, name_=gname: self.switch_chat(id_, None, name_)
            )
            btn.pack(fill=tk.X, pady=2)
            
        # Add friends to联系人
        for f in self.friends:
            fusername = f.get("username")
            fnickname = f.get("nickname") or fusername
            
            # FileHelper special decoration
            prefix = "📁 " if fusername == "filehelper" else "👤 "
            display_text = f"{prefix}{fnickname} (@{fusername})"
            
            btn = ctk.CTkButton(
                self.contacts_scroll,
                text=display_text,
                anchor="w",
                fg_color="transparent",
                text_color=("black", "white"),
                hover_color=("#E5E5E5", "#2B2B2B"),
                command=lambda name_=fusername, nickname_=fnickname: self.switch_chat(0, name_, nickname_)
            )
            btn.pack(fill=tk.X, pady=2)

    # --- Switch Chats & Load Messages ---
    def switch_chat(self, room_id, target_user, name):
        self.current_room_id = room_id
        self.current_target_user = target_user
        self.current_target_name = name
        
        # Update Chat Title Header
        self.lbl_chat_title.configure(text=f"{name} (@{target_user})" if target_user else name)
        
        # Clear chat view
        for child in self.chat_scroll.winfo_children():
            child.destroy()
            
        # Load history
        threading.Thread(target=self._async_load_chat_history, daemon=True).start()

    def _async_load_chat_history(self):
        headers = {"Authorization": self.token}
        if self.current_target_user:
            url = f"{self.server_url}/api/messages?target_user={self.current_target_user}"
        else:
            url = f"{self.server_url}/api/messages?room_id={self.current_room_id}"
            
        try:
            r = requests.get(url, headers=headers, timeout=5)
            if r.status_code == 200:
                msgs = r.json().get("data", [])
                # Show from oldest to newest (messages are returned newest-first from server)
                msgs.reverse()
                for m in msgs:
                    self.ui_queue.put({"cmd": "new_message", "data": m})
        except Exception as e:
            print(f"Failed to load chat history: {e}")

    # --- Renders and Formats Message in UI ---
    def append_message_to_ui(self, msg):
        # Verify if this message belongs to currently opened chat
        msg_room_id = msg.get("room_id", 0)
        msg_receiver = msg.get("receiver")
        msg_sender = msg.get("name")
        
        is_current = False
        if self.current_target_user:
            # Private chat
            if msg_room_id == 0 and (
                (msg_sender == self.current_user and msg_receiver == self.current_target_user) or
                (msg_sender == self.current_target_user and msg_receiver == self.current_user)
            ):
                is_current = True
        else:
            # Group chat / Public Lobby
            if msg_room_id == self.current_room_id and msg_receiver is None:
                is_current = True
                
        if not is_current:
            return  # Belongs to another chat tab, ignore rendering
            
        content = msg.get("content", "").strip()
        sender_nick = msg.get("nickname") or msg_sender
        time_str = msg.get("time", "").split("T")[-1][:5] # Get HH:MM
        
        is_me = msg_sender == self.current_user
        
        # Build message bubble container
        bubble_frame = ctk.CTkFrame(self.chat_scroll, fg_color="transparent")
        bubble_frame.pack(fill=tk.X, pady=5)
        
        # Alignment & Background details
        align = "e" if is_me else "w"
        padx_val = (100, 10) if is_me else (10, 100)
        bg_color = ("#1976D2", "#1E88E5") if is_me else ("#E0E0E0", "#3E3E3E")
        text_color = "white" if is_me else ("black", "white")
        
        # Sender nickname header
        lbl_info = ctk.CTkLabel(bubble_frame, text=f"{sender_nick} ({time_str})", font=ctk.CTkFont(size=10), text_color="gray")
        lbl_info.pack(anchor=align, padx=padx_val)
        
        content_frame = ctk.CTkFrame(bubble_frame, fg_color=bg_color, corner_radius=10)
        content_frame.pack(anchor=align, padx=padx_val, pady=2)
        
        # Parse Rich Text Types (Image, File, Namecard)
        if content.startswith("[img:") and content.endswith("]"):
            img_url = content[5:-1]
            self.render_image_bubble(content_frame, img_url)
        elif content.startswith("[file:") and content.endswith("]"):
            file_data = content[6:-1].split("|")
            download_url = file_data[0]
            filename = file_data[1] if len(file_data) > 1 else "附件"
            self.render_file_bubble(content_frame, download_url, filename)
        elif content.startswith("[user_card:") and content.endswith("]"):
            card_data = content[11:-1].split(":")
            card_username = card_data[0]
            card_nickname = card_data[1] if len(card_data) > 1 else card_username
            try:
                card_nickname = requests.utils.unquote(card_nickname)
            except:
                pass
            self.render_namecard_bubble(content_frame, card_username, card_nickname)
        else:
            # Regular Text Bubble
            lbl_msg = ctk.CTkLabel(content_frame, text=content, text_color=text_color, justify="left", wraplength=450)
            lbl_msg.pack(padx=12, pady=8)
            
        # Auto-scroll to bottom
        self.chat_scroll._parent_canvas.yview_moveto(1.0)

    # --- Special Bubble Renderers ---
    def render_image_bubble(self, parent, img_url):
        full_url = img_url if img_url.startswith("http") else f"{self.server_url}{img_url}"
        lbl_loading = ctk.CTkLabel(parent, text="图片加载中...", text_color="gray")
        lbl_loading.pack(padx=12, pady=8)
        
        def _async_load_img():
            try:
                if full_url in self.image_cache:
                    img_data = self.image_cache[full_url]
                else:
                    r = requests.get(full_url, timeout=10)
                    img_data = r.content
                    self.image_cache[full_url] = img_data
                    
                image = Image.open(io.BytesIO(img_data))
                
                # Resize keeping aspect ratio
                max_w, max_h = 250, 180
                w, h = image.size
                ratio = min(max_w/w, max_h/h)
                new_w, new_h = int(w * ratio), int(h * ratio)
                
                ctk_img = ctk.CTkImage(light_image=image, dark_image=image, size=(new_w, new_h))
                
                def _update_ui():
                    lbl_loading.destroy()
                    lbl_img = ctk.CTkLabel(parent, image=ctk_img, text="")
                    lbl_img.image = ctk_img
                    lbl_img.pack(padx=8, pady=8)
                self.after(10, _update_ui)
            except Exception as e:
                print(f"Failed to load image: {e}")
                
        threading.Thread(target=_async_load_img, daemon=True).start()

    def render_file_bubble(self, parent, download_url, filename):
        full_url = download_url if download_url.startswith("http") else f"{self.server_url}{download_url}"
        
        lbl_file = ctk.CTkLabel(parent, text=f"📂 {filename}", text_color=("black", "white"), font=ctk.CTkFont(weight="bold"))
        lbl_file.pack(padx=15, pady=(10, 2), anchor="w")
        
        btn_dl = ctk.CTkButton(parent, text="下载该文件", height=24, fg_color="#4CAF50", hover_color="#45a049", font=ctk.CTkFont(size=11), command=lambda: self.download_file(full_url, filename))
        btn_dl.pack(padx=15, pady=(2, 10), fill=tk.X)

    def download_file(self, url, default_name):
        dest = filedialog.asksaveasfilename(initialfile=default_name, title="保存文件")
        if not dest:
            return
            
        def _async_download():
            try:
                r = requests.get(url, timeout=30)
                with open(dest, 'wb') as f:
                    f.write(r.content)
                self.ui_queue.put({"cmd": "toast", "text": "文件下载并保存成功！"})
            except Exception as e:
                self.ui_queue.put({"cmd": "error", "text": f"下载失败: {e}"})
                
        threading.Thread(target=_async_download, daemon=True).start()

    def render_namecard_bubble(self, parent, username, nickname):
        lbl_title = ctk.CTkLabel(parent, text="📇 个人名片", text_color="#1565C0", font=ctk.CTkFont(size=11, weight="bold"))
        lbl_title.pack(padx=15, pady=(8, 2), anchor="w")
        
        lbl_nick = ctk.CTkLabel(parent, text=nickname, font=ctk.CTkFont(size=14, weight="bold"))
        lbl_nick.pack(padx=15, pady=1, anchor="w")
        
        lbl_uname = ctk.CTkLabel(parent, text=f"@{username}", text_color="gray", font=ctk.CTkFont(size=11))
        lbl_uname.pack(padx=15, pady=(1, 8), anchor="w")
        
        btn_view = ctk.CTkButton(parent, text="查看个人资料 / 发起聊天", height=24, font=ctk.CTkFont(size=11), command=lambda: self.show_user_profile_dialog(username, nickname))
        btn_view.pack(padx=15, pady=(0, 10), fill=tk.X)

    # --- Attachment Options & Dialogs ---
    def show_attachment_options(self):
        options_dialog = ctk.CTkToplevel(self)
        options_dialog.title("发送附件")
        options_dialog.geometry("300x200")
        options_dialog.resizable(False, False)
        options_dialog.attributes("-topmost", True)
        
        # Center dialog relative to main window
        x = self.winfo_x() + (self.winfo_width() // 2) - 150
        y = self.winfo_y() + (self.winfo_height() // 2) - 100
        options_dialog.geometry(f"+{x}+{y}")
        
        lbl = ctk.CTkLabel(options_dialog, text="请选择附件类型", font=ctk.CTkFont(size=14, weight="bold"))
        lbl.pack(pady=15)
        
        btn_img = ctk.CTkButton(options_dialog, text="发送图片", command=lambda: [options_dialog.destroy(), self.pick_and_upload_file(is_image=True)])
        btn_img.pack(pady=5, padx=20, fill=tk.X)
        
        btn_file = ctk.CTkButton(options_dialog, text="发送文件", command=lambda: [options_dialog.destroy(), self.pick_and_upload_file(is_image=False)])
        btn_file.pack(pady=5, padx=20, fill=tk.X)
        
        btn_card = ctk.CTkButton(options_dialog, text="推荐好友名片", command=lambda: [options_dialog.destroy(), self.show_share_card_selector_dialog()])
        btn_card.pack(pady=5, padx=20, fill=tk.X)

    def pick_and_upload_file(self, is_image=False):
        ftypes = [("Image files", "*.jpg;*.jpeg;*.png;*.gif;*.webp")] if is_image else [("All files", "*.*")]
        filepath = filedialog.askopenfilename(filetypes=ftypes, title="选择文件")
        if not filepath:
            return
            
        threading.Thread(target=self._async_upload_file, args=(filepath, is_image), daemon=True).start()

    def _async_upload_file(self, filepath, is_image):
        filename = os.path.basename(filepath)
        headers = {"Authorization": self.token}
        
        try:
            with open(filepath, 'rb') as f:
                files = {'file': (filename, f)}
                r = requests.post(f"{self.server_url}/api/upload", headers=headers, files=files, timeout=60)
                
            if r.status_code == 200:
                data = r.json()
                url = data.get("url")
                download_url = data.get("download_url")
                
                # Send corresponding rich text tag in message
                formatted_msg = f"[img:{url}]" if is_image else f"[file:{download_url}|{filename}]"
                self.send_direct_message(formatted_msg)
            else:
                self.ui_queue.put({"cmd": "error", "text": "文件上传失败，服务器拒绝！"})
        except Exception as e:
            self.ui_queue.put({"cmd": "error", "text": f"上传出错: {e}"})

    def show_share_card_selector_dialog(self):
        dialog = ctk.CTkToplevel(self)
        dialog.title("推荐好友名片")
        dialog.geometry("320x350")
        dialog.resizable(False, False)
        dialog.attributes("-topmost", True)
        
        x = self.winfo_x() + (self.winfo_width() // 2) - 160
        y = self.winfo_y() + (self.winfo_height() // 2) - 175
        dialog.geometry(f"+{x}+{y}")
        
        lbl = ctk.CTkLabel(dialog, text="选择推荐的好友名片", font=ctk.CTkFont(weight="bold"))
        lbl.pack(pady=10)
        
        scroll = ctk.CTkScrollableFrame(dialog, fg_color="transparent")
        scroll.pack(fill=tk.BOTH, expand=True, padx=15, pady=10)
        
        filtered_friends = [f for f in self.friends if f.get("username") != "filehelper" and f.get("username") != self.current_user]
        
        if not filtered_friends:
            lbl_empty = ctk.CTkLabel(scroll, text="暂无好友可推荐", text_color="gray")
            lbl_empty.pack(pady=20)
        else:
            for f in filtered_friends:
                uname = f.get("username")
                nick = f.get("nickname") or uname
                btn = ctk.CTkButton(scroll, text=f"{nick} (@{uname})", height=32, command=lambda u=uname, n=nick: [dialog.destroy(), self.send_card_message(u, n)])
                btn.pack(fill=tk.X, pady=3)

    def send_card_message(self, username, nickname):
        encoded_nick = requests.utils.quote(nickname)
        card_content = f"[user_card:{username}:{encoded_nick}]"
        self.send_direct_message(card_content)

    def send_direct_message(self, content):
        headers = {"Authorization": self.token}
        body = {"content": content, "room_id": self.current_room_id}
        if self.current_target_user:
            body["receiver"] = self.current_target_user
            
        try:
            r = requests.post(f"{self.server_url}/api/messages", headers=headers, json=body, timeout=5)
            if r.status_code != 200:
                self.ui_queue.put({"cmd": "error", "text": "发送失败"})
        except Exception as e:
            self.ui_queue.put({"cmd": "error", "text": f"网络异常: {e}"})

    # --- User Search & Profile Dialog ---
    def show_search_add_dialog(self):
        dialog = ctk.CTkToplevel(self)
        dialog.title("搜索用户 / 创建群聊")
        dialog.geometry("380x350")
        dialog.resizable(False, False)
        dialog.attributes("-topmost", True)
        
        x = self.winfo_x() + (self.winfo_width() // 2) - 190
        y = self.winfo_y() + (self.winfo_height() // 2) - 175
        dialog.geometry(f"+{x}+{y}")
        
        tabview = ctk.CTkTabview(dialog)
        tabview.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        tab_user = tabview.add("查找用户")
        tab_group = tabview.add("创建群聊")
        
        # User Tab UI
        lbl_u = ctk.CTkLabel(tab_user, text="输入用户名或昵称搜索")
        lbl_u.pack(pady=10)
        
        entry_u = ctk.CTkEntry(tab_user, placeholder_text="搜索词")
        entry_u.pack(pady=5, padx=20, fill=tk.X)
        
        results_scroll = ctk.CTkScrollableFrame(tab_user, height=120, fg_color="transparent")
        results_scroll.pack(fill=tk.BOTH, expand=True, padx=20, pady=10)
        
        def do_user_search():
            q = entry_u.get().strip()
            if not q: return
            
            for child in results_scroll.winfo_children():
                child.destroy()
                
            headers = {"Authorization": self.token}
            try:
                r = requests.get(f"{self.server_url}/api/users/search?q={q}", headers=headers, timeout=5)
                if r.status_code == 200:
                    users = r.json()
                    if not users:
                        lbl_none = ctk.CTkLabel(results_scroll, text="未查找到匹配用户", text_color="gray")
                        lbl_none.pack(pady=10)
                    else:
                        for u in users:
                            uname = u.get("username")
                            nick = u.get("nickname") or uname
                            
                            row = ctk.CTkFrame(results_scroll, fg_color="transparent")
                            row.pack(fill=tk.X, pady=2)
                            
                            lbl_row = ctk.CTkLabel(row, text=f"{nick} (@{uname})")
                            lbl_row.pack(side=tk.LEFT)
                            
                            btn_action = ctk.CTkButton(row, text="查看资料", width=80, height=24, command=lambda un=uname, nk=nick: [dialog.destroy(), self.show_user_profile_dialog(un, nk)])
                            btn_action.pack(side=tk.RIGHT)
            except Exception as e:
                messagebox.showerror("错误", f"搜索失败: {e}")
                
        btn_search_u = ctk.CTkButton(tab_user, text="搜索", command=do_user_search)
        btn_search_u.pack(pady=5, padx=20, fill=tk.X)
        
        # Group Tab UI
        lbl_g = ctk.CTkLabel(tab_group, text="新建群聊名称")
        lbl_g.pack(pady=10)
        
        entry_g = ctk.CTkEntry(tab_group, placeholder_text="新群聊名")
        entry_g.pack(pady=5, padx=20, fill=tk.X)
        
        def do_create_group():
            name = entry_g.get().strip()
            if not name: return
            
            headers = {"Authorization": self.token}
            try:
                r = requests.post(f"{self.server_url}/api/groups", headers=headers, json={"name": name, "is_public": 1}, timeout=5)
                if r.status_code == 200:
                    messagebox.showinfo("成功", f"群聊 '{name}' 创建成功！")
                    dialog.destroy()
                    self.load_friends_and_groups()
                else:
                    messagebox.showerror("错误", "创建失败！")
            except Exception as e:
                messagebox.showerror("错误", f"创建群聊异常: {e}")
                
        btn_create_g = ctk.CTkButton(tab_group, text="确认创建", command=do_create_group)
        btn_create_g.pack(pady=15, padx=20, fill=tk.X)

    def show_user_profile_dialog(self, username, nickname):
        if username == "filehelper":
            messagebox.showinfo("文件传输助手", "这是您的个人专属文件传输助手，发送到这里的消息、图片与文件都将保存在云端并同步到您的其他设备。")
            return
            
        dialog = ctk.CTkToplevel(self)
        dialog.title("用户资料")
        dialog.geometry("320x360")
        dialog.resizable(False, False)
        dialog.attributes("-topmost", True)
        
        x = self.winfo_x() + (self.winfo_width() // 2) - 160
        y = self.winfo_y() + (self.winfo_height() // 2) - 180
        dialog.geometry(f"+{x}+{y}")
        
        # UI Elements
        lbl_avatar = ctk.CTkLabel(dialog, text="👤", font=ctk.CTkFont(size=64))
        lbl_avatar.pack(pady=(30, 10))
        
        lbl_nick = ctk.CTkLabel(dialog, text=nickname, font=ctk.CTkFont(size=18, weight="bold"))
        lbl_nick.pack(pady=2)
        
        lbl_uname = ctk.CTkLabel(dialog, text=f"@{username}", text_color="gray", font=ctk.CTkFont(size=12))
        lbl_uname.pack(pady=(0, 20))
        
        # Loader / Button Container
        btn_container = ctk.CTkFrame(dialog, fg_color="transparent")
        btn_container.pack(fill=tk.X, padx=20, pady=10)
        
        lbl_status = ctk.CTkLabel(btn_container, text="正在加载好友状态...")
        lbl_status.pack(pady=10)
        
        def _async_load_profile():
            headers = {"Authorization": self.token}
            try:
                r = requests.get(f"{self.server_url}/api/users/search?q={username}", headers=headers, timeout=5)
                if r.status_code == 200:
                    users = r.json()
                    u = next((item for item in users if item["username"] == username), None)
                    
                    def _update_ui():
                        lbl_status.destroy()
                        if not u:
                            ctk.CTkLabel(btn_container, text="未获取到该用户信息", text_color="red").pack(pady=10)
                            return
                            
                        # Show action buttons according to friendship status
                        is_friend = u.get("isFriend", False)
                        req_status = u.get("requestStatus")
                        req_dir = u.get("requestDirection")
                        
                        if is_friend:
                            btn_chat = ctk.CTkButton(btn_container, text="发送消息", command=lambda: [dialog.destroy(), self.switch_chat(0, username, nickname)])
                            btn_chat.pack(pady=5, fill=tk.X)
                            
                            btn_del = ctk.CTkButton(btn_container, text="删除好友", fg_color="#E53935", hover_color="#D32F2F", command=lambda: self.confirm_delete_friend(dialog, username))
                            btn_del.pack(pady=5, fill=tk.X)
                        else:
                            if req_status == "pending" and req_dir == "sent":
                                btn_wait = ctk.CTkButton(btn_container, text="已发送申请 (等待验证)", state=tk.DISABLED)
                                btn_wait.pack(pady=5, fill=tk.X)
                            elif req_status == "pending" and req_dir == "received":
                                btn_accept = ctk.CTkButton(btn_container, text="同意好友验证申请", command=lambda: self.respond_request(dialog, username, "accept"))
                                btn_accept.pack(pady=5, fill=tk.X)
                            else:
                                btn_add = ctk.CTkButton(btn_container, text="加为好友", command=lambda: self.send_friend_request(dialog, username))
                                btn_add.pack(pady=5, fill=tk.X)
                                
                    self.after(10, _update_ui)
            except Exception as e:
                print(f"Failed to fetch profile: {e}")
                
        threading.Thread(target=_async_load_profile, daemon=True).start()

    def send_friend_request(self, dialog_to_close, target):
        headers = {"Authorization": self.token}
        try:
            r = requests.post(f"{self.server_url}/api/friends/request", headers=headers, json={"target_username": target}, timeout=5)
            if r.status_code == 200:
                messagebox.showinfo("成功", "好友验证申请已发送！")
                dialog_to_close.destroy()
            else:
                messagebox.showerror("错误", "发送失败")
        except Exception as e:
            messagebox.showerror("错误", f"网络异常: {e}")

    def respond_request(self, dialog_to_close, target, action):
        headers = {"Authorization": self.token}
        try:
            r = requests.put(f"{self.server_url}/api/friends/request", headers=headers, json={"target_username": target, "action": action}, timeout=5)
            if r.status_code == 200:
                messagebox.showinfo("成功", "已成功同意好友申请！")
                dialog_to_close.destroy()
                self.load_friends_and_groups()
            else:
                messagebox.showerror("错误", "操作失败")
        except Exception as e:
            messagebox.showerror("错误", f"网络异常: {e}")

    def confirm_delete_friend(self, dialog_to_close, target):
        if messagebox.askyesno("删除好友", f"确定要删除好友 @{target} 吗？"):
            headers = {"Authorization": self.token}
            try:
                r = requests.delete(f"{self.server_url}/api/friends/{target}", headers=headers, timeout=5)
                if r.status_code == 200:
                    messagebox.showinfo("成功", "已成功删除该好友")
                    dialog_to_close.destroy()
                    self.load_friends_and_groups()
                    if self.current_target_user == target:
                        self.switch_chat(0, None, "公共大厅")
                else:
                    messagebox.showerror("错误", "删除失败")
            except Exception as e:
                messagebox.showerror("错误", f"网络异常: {e}")

    # --- Messaging Functions ---
    def send_message(self):
        text = self.entry_message.get().strip()
        if not text:
            return
            
        self.entry_message.delete(0, tk.END)
        
        headers = {"Authorization": self.token}
        body = {"content": text, "room_id": self.current_room_id}
        if self.current_target_user:
            body["receiver"] = self.current_target_user
            
        threading.Thread(target=self._async_send_msg, args=(headers, body), daemon=True).start()

    def _async_send_msg(self, headers, body):
        try:
            r = requests.post(f"{self.server_url}/api/messages", headers=headers, json=body, timeout=5)
            if r.status_code != 200:
                self.ui_queue.put({"cmd": "error", "text": "发送失败"})
        except Exception as e:
            self.ui_queue.put({"cmd": "error", "text": f"网络连接异常: {e}"})

    # --- Typing Indicator and Online status ---
    def show_typing_indicator(self, user):
        if self.current_target_user == user:
            self.lbl_typing.configure(text="对方正在输入...")
            self.after(3000, lambda: self.lbl_typing.configure(text=""))

    def update_online_status(self, users):
        # We can implement a list of online users on the screen if needed
        pass

if __name__ == "__main__":
    app = NativeClient()
    app.mainloop()
