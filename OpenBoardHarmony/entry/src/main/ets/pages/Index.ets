import http from '@ohos.net.http';
import webSocket from '@ohos.net.webSocket';
import promptAction from '@ohos.promptAction';
import dataPreferences from '@ohos.data.preferences';
import pasteboard from '@ohos.pasteboard';
import common from '@ohos.app.ability.common';
import Want from '@ohos.app.ability.Want';
import picker from '@ohos.file.picker';
import fs from '@ohos.file.fs';
import { BusinessError } from '@ohos.base';

interface Message {
  id?: number;
  name: string;
  nickname: string;
  content: string;
  time: string;
  room_id: number;
  isRecalled?: number;
  avatar?: string;
}

interface Relation {
  id: number;
  name: string;
  type: string; // "group" or "friend"
  targetUser?: string;
}

interface GroupItem {
  id: number;
  name: string;
}

interface FriendItem {
  username: string;
  nickname?: string;
}

interface FriendsResponse {
  data: FriendItem[];
}

interface LoginResponse {
  token: string;
  username: string;
  nickname?: string;
  avatar?: string;
}

interface HistoryResponse {
  data: Message[];
}

interface WsMsg {
  type: string;
  name?: string;
  nickname?: string;
  content?: string;
  time?: string;
  room_id?: number;
  from_user?: string;
  from_nickname?: string;
  msg_id?: number;
  avatar?: string;
}

interface SendMsgPayload {
  content: string;
  room_id: number;
  receiver?: string;
}

interface SearchedUserItem {
  username: string;
  nickname?: string;
  avatar?: string;
  is_friend: boolean;
  request_status?: string | null;
  request_direction?: string | null;
}

interface SearchResponse {
  data: SearchedUserItem[];
}

interface IncomingRequestItem {
  id: number;
  from_user: string;
  nickname?: string;
  avatar?: string;
  created_at?: string;
}

interface IncomingRequestsResponse {
  data: IncomingRequestItem[];
}

interface TypingFrame {
  type: string;
  room_id: number;
  receiver?: string;
}

@Entry
@Component
struct Index {
  @State screenState: string = "LOGIN"; // LOGIN, MAIN, CHAT, ADD_FRIEND, SETTINGS
  @State activeTabIndex: number = 0; // 0:最近会话, 1:联系人, 2:群组, 3:设置
  @State themeColor: string = "#1565C0"; // Dynamic Theme Accent color

  // Server config
  @State serverUrl: string = "http://47.93.6.111:5000";
  @State wsUrl: string = "ws://47.93.6.111:5000";
  
  // Auth inputs
  @State usernameInput: string = "";
  @State passwordInput: string = "";
  @State nicknameInput: string = "";
  @State isRegisterMode: boolean = false;
  @State loginStatusMsg: string = "";

  // Logged-in info
  @State token: string = "";
  @State currentUsername: string = "";
  @State currentUserNickname: string = "";
  @State previewImageUrl: string = "";

  // Chat Data
  @State activeRoomId: number = 0;
  @State activeTargetUser: string = "";
  @State activeChatTitle: string = "公共大厅";
  @State messages: Message[] = [];
  @State msgInput: string = "";
  @State relations: Relation[] = [];
  
  // Typing state
  @State typingIndicator: string = "";
  private lastTypingTime: number = 0;
  private typingTimer: number = 0;

  // Search & Friend requests state
  @State searchQuery: string = "";
  @State searchResults: SearchedUserItem[] = [];
  @State incomingRequests: IncomingRequestItem[] = [];

  // Pinned chats list (local settings)
  @State pinnedChats: string[] = [];

  // Local maps for snippets and badges
  @State lastMessages: Record<string, string> = {};
  @State unreadCounts: Record<string, number> = {};

  // Action modals visibility
  @State createGroupModalVisible: boolean = false;
  @State newGroupName: string = "";

  @State nicknameModalVisible: boolean = false;
  @State newNicknameVal: string = "";

  @State changePasswordModalVisible: boolean = false;
  @State oldPasswordInput: string = "";
  @State newPasswordInput: string = "";

  @State qrLoginModalVisible: boolean = false;
  @State qrCodeInput: string = "";

  @State blacklistModalVisible: boolean = false;
  @State blockedUsers: string[] = [];
  @State isTargetBlocked: boolean = false;

  @State profilePreviewVisible: boolean = false;
  @State profilePreviewUser: string = "";
  @State profilePreviewNickname: string = "";
  @State profilePreviewAvatar: string = "";
  @State profilePreviewIsFriend: boolean = false;

  @State avatarModalVisible: boolean = false;
  @State newAvatarVal: string = "";
  @State currentUserAvatar: string = "";

  // List of quick emojis
  private quickEmojis: string[] = ["😄", "😂", "😊", "😍", "👍", "🎉", "🔥", "❤️", "🤔", "😭", "😡", "👏", "🎂", "🌟", "✨"];

  // WebSocket Instance
  private ws: webSocket.WebSocket | null = null;
  private scroller: Scroller = new Scroller();

  aboutToAppear() {
    this.loadLocalSettings();
    if (this.token) {
      this.screenState = "MAIN";
      this.activeTabIndex = 0;
      this.connectWebSocket();
      this.loadRelations();
      this.loadBlockedUsers();
      this.loadHistory();
    }
  }

  aboutToDisappear() {
    this.closeWebSocket();
  }

  // Load local settings from Preferences
  loadLocalSettings() {
    try {
      let pref = dataPreferences.getPreferencesSync(getContext(this), { name: "OpenBoardPref" });
      this.serverUrl = pref.getSync("serverUrl", "http://47.93.6.111:5000") as string;
      this.wsUrl = pref.getSync("wsUrl", "ws://47.93.6.111:5000") as string;
      this.themeColor = pref.getSync("themeColor", "#1565C0") as string;
      let pins = pref.getSync("pinnedChats", "[]") as string;
      this.pinnedChats = JSON.parse(pins) as string[];
      this.token = pref.getSync("token", "") as string;
      this.currentUsername = pref.getSync("currentUsername", "") as string;
      this.currentUserNickname = pref.getSync("currentUserNickname", "") as string;
      this.currentUserAvatar = pref.getSync("currentUserAvatar", "") as string;
    } catch (e) {
      console.error("Failed to load local settings");
    }
  }

  // Save local settings to Preferences
  saveLocalSettings() {
    try {
      let pref = dataPreferences.getPreferencesSync(getContext(this), { name: "OpenBoardPref" });
      pref.putSync("serverUrl", this.serverUrl);
      pref.putSync("wsUrl", this.wsUrl);
      pref.putSync("themeColor", this.themeColor);
      pref.putSync("pinnedChats", JSON.stringify(this.pinnedChats));
      pref.putSync("token", this.token);
      pref.putSync("currentUsername", this.currentUsername);
      pref.putSync("currentUserNickname", this.currentUserNickname);
      pref.putSync("currentUserAvatar", this.currentUserAvatar);
      pref.flushSync();
    } catch (e) {
      console.error("Failed to save local settings");
    }
  }

  // Connect WebSocket
  connectWebSocket() {
    if (this.ws) {
      this.closeWebSocket();
    }
    
    this.ws = webSocket.createWebSocket();
    let connectUrl = `${this.wsUrl}/ws/${this.token}`;
    
    this.ws.connect(connectUrl, (err: BusinessError, value: boolean) => {
      if (!err) {
        console.info("HarmonyOS WebSocket Connected successfully!");
      } else {
        console.error("HarmonyOS WebSocket connection failed: " + JSON.stringify(err));
      }
    });

    this.ws.on('message', (err: BusinessError, value: string | ArrayBuffer) => {
      if (!err && value) {
        try {
          let dataStr: string = "";
          if (typeof value === 'string') {
            dataStr = value as string;
          }
          if (dataStr) {
            let dataObj = JSON.parse(dataStr) as WsMsg;
            if (dataObj.type === "message") {
              let msg: Message = {
                name: dataObj.name || "",
                nickname: dataObj.nickname || dataObj.name || "",
                content: dataObj.content || "",
                time: dataObj.time || new Date().toISOString(),
                room_id: dataObj.room_id || 0,
                avatar: dataObj.avatar || ""
              };
              
              let key = msg.room_id > 0 ? `group:${msg.room_id}` : `friend:${msg.name}`;
              
              // Extract snippet representation
              let snippet = msg.content;
              if (msg.content.startsWith("[img:")) snippet = "[图片]";
              else if (msg.content.startsWith("[file:")) snippet = "[文件]";
              else if (msg.content.startsWith("[user_card:")) snippet = "[名片]";
              this.lastMessages[key] = snippet;
              
              // Increment unread count if we are not actively in this screen
              let isCurrentActiveScreen = (this.screenState === "CHAT" && 
                (msg.room_id > 0 ? this.activeRoomId === msg.room_id : this.activeTargetUser === msg.name));
              
              if (!isCurrentActiveScreen) {
                this.unreadCounts[key] = (this.unreadCounts[key] || 0) + 1;
              }
              
              // Check if matches active screen
              if (msg.room_id === this.activeRoomId && (msg.room_id > 0 || msg.name === this.activeTargetUser || this.currentUsername === msg.name)) {
                this.messages.push(msg);
                this.scrollToBottom();
              }
            } else if (dataObj.type === "typing") {
              // Show typing indicator if match
              let isMyChat = (dataObj.room_id === this.activeRoomId && 
                (dataObj.room_id > 0 || dataObj.name === this.activeTargetUser));
              
              if (isMyChat && dataObj.name !== this.currentUsername) {
                this.typingIndicator = "对方正在输入...";
                if (this.typingTimer) {
                  clearTimeout(this.typingTimer);
                }
                this.typingTimer = setTimeout(() => {
                  this.typingIndicator = "";
                }, 3000);
              }
            } else if (dataObj.type === "friend_request") {
              promptAction.showToast({ message: `收到来自 ${dataObj.from_nickname || dataObj.from_user} 的好友申请` });
              this.loadFriendRequests();
            } else if (dataObj.type === "friend_accepted") {
              promptAction.showToast({ message: `您与 ${dataObj.from_nickname || dataObj.from_user} 已成为好友` });
              this.loadRelations();
            } else if (dataObj.type === "recall") {
              // Real-time message recall handler
              let recalledId = dataObj.msg_id;
              if (recalledId) {
                for (let i = 0; i < this.messages.length; i++) {
                  if (this.messages[i].id === recalledId) {
                    this.messages[i].content = "[system_recalled]";
                    break;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error("Error parsing WS message");
        }
      }
    });

    this.ws.on('close', (err: BusinessError, value: Object) => {
      console.info("HarmonyOS WebSocket Closed");
    });
  }

  closeWebSocket() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // Copy to clipboard
  copyToClipboard(text: string) {
    try {
      let pasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      let systemPasteboard = pasteboard.getSystemPasteboard();
      systemPasteboard.setData(pasteData).then(() => {
        promptAction.showToast({ message: "已复制下载链接到剪贴板" });
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "复制失败，链接为: " + text });
      });
    } catch(e) {
      promptAction.showToast({ message: "链接为: " + text });
    }
  }

  // Open link in browser Want
  openBrowserUrl(url: string) {
    try {
      let context = getContext(this) as common.UIAbilityContext;
      let want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: url
      };
      context.startAbility(want).then(() => {
        console.info("Opened URL in browser successfully");
      }).catch((err: BusinessError) => {
        promptAction.showToast({ message: "无法打开浏览器，请手动复制链接" });
      });
    } catch(e) {
      promptAction.showToast({ message: "打开链接失败" });
    }
  }

  // Prompt options for file card click
  showFileDownloadOptions(filename: string, url: string) {
    promptAction.showActionMenu({
      title: filename,
      buttons: [
        { text: "🌐 浏览器打开下载", color: this.themeColor },
        { text: "📋 复制下载链接", color: "#4CAF50" }
      ]
    }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
      if (!err) {
        if (data.index === 0) {
          this.openBrowserUrl(url);
        } else if (data.index === 1) {
          this.copyToClipboard(url);
        }
      }
    });
  }

  // Convert ArrayBuffer to Base64 using pure TypeScript
  arrayBufferToBase64(buffer: ArrayBuffer): string {
    let bytes = new Uint8Array(buffer);
    let len = bytes.byteLength;
    let base64 = "";
    let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < len; i += 3) {
      let b1 = bytes[i];
      let b2 = i + 1 < len ? bytes[i+1] : NaN;
      let b3 = i + 2 < len ? bytes[i+2] : NaN;
      
      let enc1 = b1 >> 2;
      let enc2 = ((b1 & 3) << 4) | (Number.isNaN(b2) ? 0 : b2 >> 4);
      let enc3 = Number.isNaN(b2) ? 64 : (((b2 & 15) << 2) | (Number.isNaN(b3) ? 0 : b3 >> 6));
      let enc4 = Number.isNaN(b3) ? 64 : (b3 & 63);
      
      base64 += chars.charAt(enc1) + chars.charAt(enc2) + (enc3 === 64 ? "=" : chars.charAt(enc3)) + (enc4 === 64 ? "=" : chars.charAt(enc4));
    }
    return base64;
  }

  // Open photo picker to select avatar
  selectAvatarFromGallery() {
    try {
      let photoPicker = new picker.PhotoViewPicker();
      photoPicker.select({
        MIMEType: picker.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 1
      }).then((result: picker.PhotoSelectResult) => {
        if (result && result.photoUris && result.photoUris.length > 0) {
          let uri = result.photoUris[0];
          
          let file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
          let stat = fs.statSync(file.fd);
          let buffer = new ArrayBuffer(stat.size);
          fs.readSync(file.fd, buffer);
          fs.closeSync(file);
          
          let base64Str = this.arrayBufferToBase64(buffer);
          this.newAvatarVal = `data:image/png;base64,${base64Str}`;
          promptAction.showToast({ message: "本地图片选择成功" });
        }
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "图库选择异常" });
      });
    } catch(e) {
      promptAction.showToast({ message: "打开图库失败" });
    }
  }

  // Update Avatar API
  updateAvatarApi() {
    if (!this.newAvatarVal.trim()) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/user/profile`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          avatar: this.newAvatarVal
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "头像更新成功" });
          this.currentUserAvatar = this.newAvatarVal;
          this.avatarModalVisible = false;
          this.newAvatarVal = "";
          this.saveLocalSettings();
          this.loadRelations();
        } else {
          promptAction.showToast({ message: "头像更新失败" });
        }
      }
    );
  }

  // Get consistent hash color for avatars
  getAvatarBgColor(username: string): string {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    let colors = ["#FF5722", "#4CAF50", "#2196F3", "#9C27B0", "#E91E63", "#FF9800", "#009688", "#795548"];
    let idx = Math.abs(hash) % colors.length;
    return colors[idx];
  }

  // Show profile and avatar preview dialog
  showUserAvatarPreview(nickname: string, username: string, avatar: string) {
    if (username === "filehelper") {
      promptAction.showDialog({
        title: "文件传输助手",
        message: "这是您的个人专属文件传输助手，发送到这里的消息、图片与文件都将保存在云端并同步到您的其他设备。",
        buttons: [{ text: "确定", color: this.themeColor }]
      });
      return;
    }
    
    this.profilePreviewNickname = nickname;
    this.profilePreviewUser = username;
    this.profilePreviewAvatar = avatar;
    
    // Check if the user is in relations (friend list)
    let isFriend = false;
    for (let i = 0; i < this.relations.length; i++) {
      if (this.relations[i].type === "friend" && this.relations[i].targetUser === username) {
        isFriend = true;
        break;
      }
    }
    this.profilePreviewIsFriend = isFriend;
    this.profilePreviewVisible = true;
  }

  // Throttled typing indicator broadcast
  triggerTyping() {
    let now = Date.now();
    if (now - this.lastTypingTime > 2500) {
      this.lastTypingTime = now;
      if (this.ws) {
        let typingFrame: TypingFrame = {
          type: "typing",
          room_id: this.activeRoomId,
          receiver: this.activeTargetUser
        };
        this.ws.send(JSON.stringify(typingFrame));
      }
    }
  }

  // Auto-scroll helper
  scrollToBottom() {
    setTimeout(() => {
      this.scroller.scrollEdge(Edge.Bottom);
    }, 150);
  }

  // Load chat history
  loadHistory() {
    let apiPath = "";
    if (this.activeRoomId > 0) {
      apiPath = `${this.serverUrl}/api/messages?room_id=${this.activeRoomId}`;
    } else if (this.activeTargetUser) {
      apiPath = `${this.serverUrl}/api/messages?target_user=${this.activeTargetUser}`;
    } else {
      apiPath = `${this.serverUrl}/api/messages?room_id=0`;
    }

    let httpRequest = http.createHttp();
    httpRequest.request(
      apiPath,
      {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': this.token
        }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as HistoryResponse;
            let rawList: Message[] = res.data || [];
            // API returns oldest first (ASC), display directly
            this.messages = rawList;
            
            // Set last message snippet
            if (rawList.length > 0) {
              let key = this.activeRoomId > 0 ? `group:${this.activeRoomId}` : `friend:${this.activeTargetUser}`;
              let lastMsg = rawList[rawList.length - 1];
              let snippet = lastMsg.content;
              if (lastMsg.content.startsWith("[img:")) snippet = "[图片]";
              else if (lastMsg.content.startsWith("[file:")) snippet = "[文件]";
              else if (lastMsg.content.startsWith("[user_card:")) snippet = "[名片]";
              this.lastMessages[key] = snippet;
            }
            
            this.scrollToBottom();
          } catch (e) {
            console.error("Error parsing chat history");
          }
        }
      }
    );
  }

  // Load groups & friends in parallel to avoid mutual blockages
  loadRelations() {
    let tokenVal = this.token;
    let sUrl = this.serverUrl;
    
    let grps: Relation[] = [];
    let friends: Relation[] = [];
    
    let groupFinished = false;
    let friendFinished = false;
    
    let checkAndMerge = () => {
      if (groupFinished && friendFinished) {
        this.relations = grps.concat(friends);
      }
    };

    // 1. Groups
    let groupRequest = http.createHttp();
    groupRequest.request(
      `${sUrl}/api/groups`,
      {
        method: http.RequestMethod.GET,
        header: { 'Authorization': tokenVal }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        groupFinished = true;
        if (!err && data.responseCode === 200) {
          try {
            let list = JSON.parse(data.result as string) as GroupItem[];
            grps = list.map((g: GroupItem): Relation => {
              return { id: g.id, name: g.name, type: "group" };
            });
          } catch (e) {
            console.error("Error parsing groups");
          }
        }
        checkAndMerge();
      }
    );

    // 2. Friends
    let friendRequest = http.createHttp();
    friendRequest.request(
      `${sUrl}/api/friends`,
      {
        method: http.RequestMethod.GET,
        header: { 'Authorization': tokenVal }
      },
      (fErr: BusinessError, fData: http.HttpResponse) => {
        friendFinished = true;
        if (!fErr && fData.responseCode === 200) {
          try {
            let fRes = JSON.parse(fData.result as string) as FriendsResponse;
            let friendsRaw = fRes.data || [];
            friends = friendsRaw.map((f: FriendItem): Relation => {
              return { id: 0, name: f.nickname || f.username, type: "friend", targetUser: f.username };
            });
          } catch (e) {
            console.error("Error parsing friends");
          }
        }
        checkAndMerge();
      }
    );
  }

  // Sort relations with pinned items floating to the top
  getSortedRelations(): Relation[] {
    let pinnedList: Relation[] = [];
    let unpinnedList: Relation[] = [];
    
    for (let i = 0; i < this.relations.length; i++) {
      let r = this.relations[i];
      let key = r.type === "group" ? `group:${r.id}` : `friend:${r.targetUser}`;
      if (this.pinnedChats.indexOf(key) !== -1) {
        pinnedList.push(r);
      } else {
        unpinnedList.push(r);
      }
    }
    return pinnedList.concat(unpinnedList);
  }

  // Toggle Pinned chat state
  togglePinChat(item: Relation) {
    let key = item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`;
    let idx = this.pinnedChats.indexOf(key);
    if (idx !== -1) {
      this.pinnedChats.splice(idx, 1);
      promptAction.showToast({ message: "已取消置顶" });
    } else {
      this.pinnedChats.push(key);
      promptAction.showToast({ message: "已置顶该聊天" });
    }
    this.saveLocalSettings();
  }

  // Check if a relation is pinned
  isPinned(item: Relation): boolean {
    let key = item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`;
    return this.pinnedChats.indexOf(key) !== -1;
  }

  showRelationOptions(item: Relation) {
    let isPinned = this.isPinned(item);
    if (item.type === "friend") {
      promptAction.showActionMenu({
        title: item.name,
        buttons: [
          { text: isPinned ? "📌 取消置顶" : "📌 置顶该聊天", color: this.themeColor },
          { text: "❌ 删除好友关系", color: "#FF3B30" }
        ]
      }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
        if (!err) {
          if (data.index === 0) {
            this.togglePinChat(item);
          } else if (data.index === 1) {
            promptAction.showDialog({
              title: "删除好友确认",
              message: `确定要删除好友 @${item.targetUser} 吗？删除后双方将无法发送私信。`,
              buttons: [
                { text: "取消", color: "#808080" },
                { text: "确认删除", color: "#FF3B30" }
              ]
            }, (dialogErr: BusinessError, dialogData: promptAction.ShowDialogSuccessResponse) => {
              if (!dialogErr && dialogData.index === 1) {
                this.deleteFriendApi(item.targetUser || "");
              }
            });
          }
        }
      });
    } else {
      promptAction.showActionMenu({
        title: item.name,
        buttons: [
          { text: isPinned ? "📌 取消置顶" : "📌 置顶该聊天", color: this.themeColor }
        ]
      }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
        if (!err && data.index === 0) {
          this.togglePinChat(item);
        }
      });
    }
  }

  // Show recall action sheet for user messages
  showMsgActions(msg: Message) {
    if (msg.name !== this.currentUsername || !msg.id) return;
    
    promptAction.showActionMenu({
      title: "操作消息",
      buttons: [
        { text: "撤回消息", color: "#FF3B30" }
      ]
    }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
      if (!err && data.index === 0 && msg.id) {
        this.recallMessageApi(msg.id);
      }
    });
  }

  // Recall Message API Call
  recallMessageApi(msgId: number) {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/messages/${msgId}`,
      {
        method: http.RequestMethod.DELETE,
        header: { 'Authorization': this.token }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "消息已撤回" });
          // Update locally
          for (let i = 0; i < this.messages.length; i++) {
            if (this.messages[i].id === msgId) {
              this.messages[i].content = "[system_recalled]";
              break;
            }
          }
        } else {
          try {
            let res = JSON.parse(data.result as string) as Record<string, string>;
            if (res.detail) {
              promptAction.showToast({ message: res.detail });
              return;
            }
          } catch(e) {}
          promptAction.showToast({ message: "只能撤回2分钟内的消息" });
        }
      }
    );
  }

  // Fetch pending requests
  loadFriendRequests() {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/friends/requests`,
      {
        method: http.RequestMethod.GET,
        header: { 'Authorization': this.token }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as IncomingRequestsResponse;
            this.incomingRequests = res.data || [];
          } catch (e) {
            console.error("Error parsing friend requests");
          }
        }
      }
    );
  }

  // Search users
  searchUsers() {
    if (!this.searchQuery.trim()) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/users/search?q=${encodeURIComponent(this.searchQuery)}`,
      {
        method: http.RequestMethod.GET,
        header: { 'Authorization': this.token }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as SearchResponse;
            this.searchResults = res.data || [];
          } catch (e) {
            console.error("Error parsing user search results");
          }
        }
      }
    );
  }

  // Send friend request
  sendRequest(targetUsername: string) {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/friends/request`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          to_user: targetUsername
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
          promptAction.showToast({ message: "好友申请发送成功" });
          this.searchUsers();
        } else {
          promptAction.showToast({ message: "发送申请失败" });
        }
      }
    );
  }

  // Respond to incoming friend request
  respondRequest(fromUser: string, action: string) {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/friends/respond`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          from_user: fromUser,
          action: action
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: action === "accept" ? "已同意好友申请" : "已拒绝好友申请" });
          this.loadFriendRequests();
          this.loadRelations();
        } else {
          promptAction.showToast({ message: "操作失败" });
        }
      }
    );
  }

  // Delete Friend API
  deleteFriendApi(username: string) {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/friends/${username}`,
      {
        method: http.RequestMethod.DELETE,
        header: { 'Authorization': this.token }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "已成功删除该好友" });
          this.loadRelations();
          if (this.screenState === "CHAT" && this.activeTargetUser === username) {
            this.screenState = "MAIN";
          }
        } else {
          promptAction.showToast({ message: "删除好友失败" });
        }
      }
    );
  }

  // Toggle Block User API
  toggleBlockUserApi(username: string) {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/user/block`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          target_username: username
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as Record<string, Object>;
            let isBlocked = res.is_blocked as boolean;
            promptAction.showToast({ message: isBlocked ? "已将对方拉黑" : "已解除拉黑" });
            
            // Sync active target blocked state
            if (this.activeTargetUser === username) {
              this.isTargetBlocked = isBlocked;
            }
            this.loadBlockedUsers();
          } catch(e) {
            console.error("Error toggling block user");
          }
        } else {
          promptAction.showToast({ message: "操作失败" });
        }
      }
    );
  }

  // Fetch Blocked User list
  loadBlockedUsers() {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/users`,
      {
        method: http.RequestMethod.GET,
        header: { 'Authorization': this.token }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as Record<string, Object>;
            let list = res.blocked_users as string[] || [];
            this.blockedUsers = list;
            
            if (this.activeTargetUser) {
              this.isTargetBlocked = this.blockedUsers.indexOf(this.activeTargetUser) !== -1;
            }
          } catch(e) {
            console.error("Error loading blocked users list");
          }
        }
      }
    );
  }

  // Create Group API
  createGroupApi() {
    if (!this.newGroupName.trim()) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/groups`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          name: this.newGroupName
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
          promptAction.showToast({ message: "群组创建成功" });
          this.createGroupModalVisible = false;
          this.newGroupName = "";
          this.loadRelations();
        } else {
          promptAction.showToast({ message: "创建群组失败" });
        }
      }
    );
  }

  // Update Nickname API
  updateNicknameApi() {
    if (!this.newNicknameVal.trim()) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/user/profile`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          nickname: this.newNicknameVal
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "昵称更新成功" });
          this.currentUserNickname = this.newNicknameVal;
          this.nicknameModalVisible = false;
          this.newNicknameVal = "";
          this.loadRelations();
        } else {
          promptAction.showToast({ message: "昵称更新失败" });
        }
      }
    );
  }

  // Change Password API
  changePasswordApi() {
    if (!this.oldPasswordInput || !this.newPasswordInput) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/user/password`,
      {
        method: http.RequestMethod.PUT,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          old_password: this.oldPasswordInput,
          new_password: this.newPasswordInput
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "密码安全修改成功" });
          this.changePasswordModalVisible = false;
          this.oldPasswordInput = "";
          this.newPasswordInput = "";
        } else {
          try {
            let res = JSON.parse(data.result as string) as Record<string, string>;
            if (res.detail) {
              promptAction.showToast({ message: res.detail });
              return;
            }
          } catch(e) {}
          promptAction.showToast({ message: "原密码验证错误" });
        }
      }
    );
  }

  // QR Login testing flow
  processQrCodeInput() {
    let input = this.qrCodeInput.trim();
    if (!input) return;
    
    let qrId = "";
    if (input.startsWith("openboard:qr_login:")) {
      qrId = input.substring("openboard:qr_login:".length).trim();
    } else {
      qrId = input;
    }

    if (!qrId) {
      promptAction.showToast({ message: "无效的二维码" });
      return;
    }

    // Step 1: Scan QR Code
    let scanRequest = http.createHttp();
    scanRequest.request(
      `${this.serverUrl}/api/qr/scan`,
      {
        method: http.RequestMethod.POST,
        header: { 'Content-Type': 'application/json' },
        extraData: JSON.stringify({ qr_id: qrId })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          // Trigger confirm dialog
          promptAction.showDialog({
            title: "网页端登录授权",
            message: "您确定要授权该网页端登录当前信语账号吗？",
            buttons: [
              { text: "取消", color: "#FF3B30" },
              { text: "授权登录", color: this.themeColor }
            ]
          }, (dialogErr: BusinessError, dialogData: promptAction.ShowDialogSuccessResponse) => {
            if (!dialogErr && dialogData.index === 1) {
              this.authorizeQrLogin(qrId);
            }
          });
        } else {
          promptAction.showToast({ message: "扫描登录失败：二维码已过期或不存在" });
        }
      }
    );
  }

  authorizeQrLogin(qrId: string) {
    let authRequest = http.createHttp();
    authRequest.request(
      `${this.serverUrl}/api/qr/authorize`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({ qr_id: qrId })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "授权成功，网页端已成功登录！" });
          this.qrLoginModalVisible = false;
          this.qrCodeInput = "";
        } else {
          promptAction.showToast({ message: "授权登录失败" });
        }
      }
    );
  }

  // Handle send message
  sendMessage() {
    if (!this.msgInput.trim()) return;
    
    let text = this.msgInput;
    this.msgInput = "";
    
    let postData: SendMsgPayload = {
      content: text,
      room_id: this.activeRoomId
    };
    if (this.activeTargetUser) {
      postData.receiver = this.activeTargetUser;
    }
    
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/messages`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify(postData)
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err) {
          // Re-load history to include ours in sync
          this.loadHistory();
        } else {
          promptAction.showToast({ message: "发送消息失败" });
        }
      }
    );
  }

  // Show FAB Menu popups
  showFabMenu() {
    promptAction.showActionMenu({
      title: "快捷菜单",
      buttons: [
        { text: "👥 创建新群聊", color: this.themeColor },
        { text: "🔍 查找并添加好友", color: "#4CAF50" },
        { text: "🔐 扫码登录测试", color: "#FF9500" }
      ]
    }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
      if (!err) {
        if (data.index === 0) {
          this.createGroupModalVisible = true;
        } else if (data.index === 1) {
          this.screenState = "ADD_FRIEND";
          this.loadFriendRequests();
        } else if (data.index === 2) {
          this.qrLoginModalVisible = true;
        }
      }
    });
  }

  // Custom tab bar builder
  @Builder TabBuilder(title: string, index: number, icon: string) {
    Column() {
      Text(icon)
        .fontSize(20)
        .fontColor(this.activeTabIndex === index ? this.themeColor : "#757575")
      Text(title)
        .fontSize(11)
        .fontColor(this.activeTabIndex === index ? this.themeColor : "#757575")
        .margin({ top: 3 })
    }
    .width("100%")
    .height(52)
    .justifyContent(FlexAlign.Center)
    .backgroundColor("#FFFFFF")
  }

  // Handle Login click
  handleLogin() {
    if (!this.usernameInput || !this.passwordInput) {
      this.loginStatusMsg = "请输入用户名和密码";
      return;
    }
    this.loginStatusMsg = "正在登录...";
    
    // Sync WS URL base
    let sUrl = this.serverUrl.trim();
    if (sUrl.startsWith("http://")) {
      this.wsUrl = sUrl.replace("http://", "ws://");
    } else if (sUrl.startsWith("https://")) {
      this.wsUrl = sUrl.replace("https://", "wss://");
    }
    this.saveLocalSettings();
    
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/login`,
      {
        method: http.RequestMethod.POST,
        header: { 'Content-Type': 'application/json' },
        extraData: JSON.stringify({
          username: this.usernameInput,
          password: this.passwordInput
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as LoginResponse;
            this.token = res.token;
            this.currentUsername = res.username;
            this.currentUserNickname = res.nickname || res.username;
            this.currentUserAvatar = res.avatar || "";
            this.saveLocalSettings();
            this.loginStatusMsg = "";
            this.screenState = "MAIN";
            this.activeTabIndex = 0;
            
            // Init WebSocket, load relation data & block lists
            this.connectWebSocket();
            this.loadRelations();
            this.loadBlockedUsers();
            this.loadHistory();
          } catch (e) {
            this.loginStatusMsg = "登录异常，请重试";
          }
        } else {
          this.loginStatusMsg = "登录失败：用户名或密码错误";
        }
      }
    );
  }

  // Handle Register click
  handleRegister() {
    if (!this.usernameInput || !this.passwordInput || !this.nicknameInput) {
      this.loginStatusMsg = "请填满所有注册字段";
      return;
    }
    this.loginStatusMsg = "正在注册...";
    
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/register`,
      {
        method: http.RequestMethod.POST,
        header: { 'Content-Type': 'application/json' },
        extraData: JSON.stringify({
          username: this.usernameInput,
          password: this.passwordInput,
          nickname: this.nicknameInput
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
          this.loginStatusMsg = "注册成功！请点击登录";
          this.isRegisterMode = false;
        } else {
          this.loginStatusMsg = "注册失败，账号名可能已存在";
        }
      }
    );
  }

  build() {
    Stack() {
      Column() {
        if (this.screenState === "LOGIN") {
          // --- LOGIN PANEL ---
          Column({ space: 15 }) {
            Text("🛡️ 信语 ROOT 系统")
              .fontSize(26)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
              .margin({ top: 60, bottom: 20 })
            
            Text("信语 HarmonyOS NEXT 原生客户端")
              .fontSize(14)
              .fontColor(Color.Gray)
              .margin({ bottom: 20 })

            TextInput({ text: this.serverUrl, placeholder: "服务器地址" })
              .width("85%")
              .height(45)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.serverUrl = val)
            
            TextInput({ text: this.usernameInput, placeholder: "用户名" })
              .width("85%")
              .height(45)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.usernameInput = val)
            
            TextInput({ text: this.passwordInput, placeholder: "密码" })
              .type(InputType.Password)
              .width("85%")
              .height(45)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.passwordInput = val)

            if (this.isRegisterMode) {
              TextInput({ text: this.nicknameInput, placeholder: "昵称 (仅注册)" })
                .width("85%")
                .height(45)
                .fontColor(Color.Black)
                .placeholderColor(Color.Gray)
                .onChange((val: string) => this.nicknameInput = val)
            }

            Text(this.loginStatusMsg)
              .fontSize(13)
              .fontColor(Color.Red)
              .height(20)

            Row({ space: 20 }) {
              if (!this.isRegisterMode) {
                Button("登 录")
                  .width(120)
                  .height(40)
                  .backgroundColor(this.themeColor)
                  .onClick(() => this.handleLogin())
                
                Button("去注册")
                  .width(120)
                  .height(40)
                  .backgroundColor(Color.Gray)
                  .onClick(() => this.isRegisterMode = true)
              } else {
                Button("注 册")
                  .width(120)
                  .height(40)
                  .backgroundColor("#4CAF50")
                  .onClick(() => this.handleRegister())
                
                Button("返回登录")
                  .width(120)
                  .height(40)
                  .backgroundColor(Color.Gray)
                  .onClick(() => this.isRegisterMode = false)
              }
            }
            .margin({ top: 15 })
          }
          .width("100%")
          .height("100%")
          .justifyContent(FlexAlign.Center)
          .backgroundColor("#F5F7FA")

        } else if (this.screenState === "MAIN") {
          // --- MAIN SCREEN WITH BOTTOM NAVIGATION ---
          Column() {
            // Header
            Row() {
              Text("💬 信语")
                .fontSize(18)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.White)
                .layoutWeight(1)
              
              // Bell notification requests manager
              Row({ space: 15 }) {
                Text("🔔 申请")
                  .fontSize(13)
                  .fontColor(Color.White)
                  .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                  .border({ width: 1, color: Color.White, radius: 4 })
                  .onClick(() => {
                    this.screenState = "ADD_FRIEND";
                    this.loadFriendRequests();
                  })
              }
            }
            .width("100%")
            .height(56)
            .backgroundColor(this.themeColor)
            .padding({ left: 16, right: 16 })
            .alignItems(VerticalAlign.Center)

            Tabs({ barPosition: BarPosition.End }) {
              // Tab 0: 最近会话 (Recent Chats)
              TabContent() {
                List() {
                  // Public Lobby Shortcut
                  ListItem() {
                    Row() {
                      Text(this.pinnedChats.indexOf("group:0") !== -1 ? "📌 💬 公共大厅" : "💬 公共大厅")
                        .fontSize(16)
                        .fontWeight(FontWeight.Medium)
                        .fontColor(this.pinnedChats.indexOf("group:0") !== -1 ? this.themeColor : Color.Black)
                        .layoutWeight(1)
                      
                      if (this.lastMessages["group:0"]) {
                        Text(this.lastMessages["group:0"])
                          .fontSize(13)
                          .fontColor(Color.Gray)
                          .maxLines(1)
                          .margin({ right: 10 })
                      }
                    }
                    .padding({ left: 16, right: 16, top: 16, bottom: 16 })
                    .width("100%")
                  }
                  .onClick(() => {
                    this.activeRoomId = 0;
                    this.activeTargetUser = "";
                    this.activeChatTitle = "公共大厅";
                    
                    this.unreadCounts["group:0"] = 0;
                    this.loadHistory();
                    this.screenState = "CHAT";
                  })
                  .gesture(
                    LongPressGesture({ repeat: false })
                      .onAction(() => {
                        let r: Relation = { id: 0, name: "公共大厅", type: "group" };
                        this.togglePinChat(r);
                      })
                  )
                  .backgroundColor(this.pinnedChats.indexOf("group:0") !== -1 ? "#F5F9FF" : Color.White)
                  .border({ width: { bottom: 1 }, color: "#F0F0F0" })

                  ForEach(this.getSortedRelations(), (item: Relation) => {
                    ListItem() {
                      Row() {
                        Column() {
                          Row() {
                            Text(this.isPinned(item) ? 
                              (item.type === "group" ? `📌 👥 ${item.name}` : `📌 👤 ${item.name}`) : 
                              (item.type === "group" ? `👥 ${item.name}` : `👤 ${item.name}`)
                            )
                              .fontSize(16)
                              .fontWeight(FontWeight.Medium)
                              .fontColor(this.isPinned(item) ? this.themeColor : Color.Black)
                              
                            if (this.unreadCounts[item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`]) {
                              Text(this.unreadCounts[item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`].toString())
                                .fontSize(10)
                                .fontColor(Color.White)
                                .backgroundColor(Color.Red)
                                .borderRadius(8)
                                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                                .margin({ left: 8 })
                            }
                          }
                          .alignItems(VerticalAlign.Center)
                          .width("100%")
                          
                          if (this.lastMessages[item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`]) {
                            Text(this.lastMessages[item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`])
                              .fontSize(13)
                              .fontColor(Color.Gray)
                              .maxLines(1)
                              .margin({ top: 4 })
                          }
                        }
                        .layoutWeight(1)
                        .alignItems(HorizontalAlign.Start)
                        
                        Text("进入")
                          .fontSize(13)
                          .fontColor(Color.Gray)
                      }
                      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
                      .width("100%")
                    }
                    .onClick(() => {
                      if (item.type === "group") {
                        this.activeRoomId = item.id;
                        this.activeTargetUser = "";
                      } else {
                        this.activeRoomId = 0;
                        this.activeTargetUser = item.targetUser || "";
                      }
                      this.activeChatTitle = item.name;
                      
                      let key = item.type === "group" ? `group:${item.id}` : `friend:${item.targetUser}`;
                      this.unreadCounts[key] = 0;
                      
                      this.loadHistory();
                      this.screenState = "CHAT";
                    })
                    .gesture(
                      LongPressGesture({ repeat: false })
                        .onAction(() => {
                          this.showRelationOptions(item);
                        })
                    )
                    .backgroundColor(this.isPinned(item) ? "#F5F9FF" : Color.White)
                    .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                  })
                }
                .width("100%")
                .height("100%")
              }.tabBar(this.TabBuilder("最近会话", 0, "💬"))

              // Tab 1: 联系人 (Contacts / Friends)
              TabContent() {
                Column() {
                  List() {
                    ForEach(this.relations.filter(r => r.type === "friend"), (item: Relation) => {
                      ListItem() {
                        Row() {
                          Text(`👤 ${item.name}`)
                            .fontSize(16)
                            .fontWeight(FontWeight.Medium)
                            .fontColor(Color.Black)
                            .layoutWeight(1)
                          
                          Text("聊聊")
                            .fontSize(13)
                            .fontColor(this.themeColor)
                        }
                        .padding({ left: 16, right: 16, top: 16, bottom: 16 })
                        .width("100%")
                      }
                      .onClick(() => {
                        this.activeRoomId = 0;
                        this.activeTargetUser = item.targetUser || "";
                        this.activeChatTitle = item.name;
                        
                        this.unreadCounts[`friend:${item.targetUser}`] = 0;
                        this.loadHistory();
                        this.screenState = "CHAT";
                      })
                      .gesture(
                        LongPressGesture({ repeat: false })
                          .onAction(() => {
                            this.showRelationOptions(item);
                          })
                      )
                      .backgroundColor(Color.White)
                      .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                    })
                  }
                  .width("100%")
                  .layoutWeight(1)
                }
                .width("100%")
                .height("100%")
              }.tabBar(this.TabBuilder("联系人", 1, "👤"))

              // Tab 2: 群组列表 (Groups)
              TabContent() {
                Column() {
                  List() {
                    ForEach(this.relations.filter(r => r.type === "group"), (item: Relation) => {
                      ListItem() {
                        Row() {
                          Text(`👥 ${item.name}`)
                            .fontSize(16)
                            .fontWeight(FontWeight.Medium)
                            .fontColor(Color.Black)
                            .layoutWeight(1)
                          
                          Text("进入")
                            .fontSize(13)
                            .fontColor(this.themeColor)
                        }
                        .padding({ left: 16, right: 16, top: 16, bottom: 16 })
                        .width("100%")
                      }
                      .onClick(() => {
                        this.activeRoomId = item.id;
                        this.activeTargetUser = "";
                        this.activeChatTitle = item.name;
                        
                        this.unreadCounts[`group:${item.id}`] = 0;
                        this.loadHistory();
                        this.screenState = "CHAT";
                      })
                      .gesture(
                        LongPressGesture({ repeat: false })
                          .onAction(() => {
                            this.showRelationOptions(item);
                          })
                      )
                      .backgroundColor(Color.White)
                      .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                    })
                  }
                  .width("100%")
                  .layoutWeight(1)
                }
                .width("100%")
                .height("100%")
              }.tabBar(this.TabBuilder("群组列表", 2, "👥"))

              // Tab 3: 设置中心 (Settings)
              TabContent() {
                Scroll() {
                  Column({ space: 15 }) {
                    // User Profile Card
                    Row() {
                      if (this.currentUserAvatar && this.currentUserAvatar.trim().length > 0) {
                        Image(this.currentUserAvatar.startsWith("data:image") ? this.currentUserAvatar : (this.currentUserAvatar.startsWith("http") ? this.currentUserAvatar : `${this.serverUrl}${this.currentUserAvatar.startsWith('/') ? '' : '/'}${this.currentUserAvatar}`))
                          .width(60)
                          .height(60)
                          .borderRadius(30)
                          .objectFit(ImageFit.Cover)
                          .margin({ right: 15 })
                          .onClick(() => {
                            this.previewImageUrl = this.currentUserAvatar.startsWith("data:image") ? this.currentUserAvatar : (this.currentUserAvatar.startsWith("http") ? this.currentUserAvatar : `${this.serverUrl}${this.currentUserAvatar.startsWith('/') ? '' : '/'}${this.currentUserAvatar}`);
                          })
                      } else {
                        Text(this.currentUserNickname.substring(0, 1).toUpperCase())
                          .fontSize(24)
                          .fontWeight(FontWeight.Bold)
                          .fontColor(Color.White)
                          .width(60)
                          .height(60)
                          .borderRadius(30)
                          .backgroundColor(this.themeColor)
                          .textAlign(TextAlign.Center)
                          .margin({ right: 15 })
                      }
                      
                      Column() {
                        Text(this.currentUserNickname)
                          .fontSize(18)
                          .fontWeight(FontWeight.Bold)
                          .fontColor(Color.Black)
                        
                        Text(`@${this.currentUsername}`)
                          .fontSize(14)
                          .fontColor(Color.Gray)
                          .margin({ top: 4 })
                      }
                      .alignItems(HorizontalAlign.Start)
                      .layoutWeight(1)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    
                    // Nickname option
                    Row() {
                      Text("✍️ 修改个性昵称")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .layoutWeight(1)
                      
                      Text(this.currentUserNickname)
                        .fontSize(14)
                        .fontColor(Color.Gray)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    .onClick(() => {
                      this.newNicknameVal = this.currentUserNickname;
                      this.nicknameModalVisible = true;
                    })

                    // Avatar option
                    Row() {
                      Text("👤 修改个人头像")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .layoutWeight(1)
                      
                      Text("点击更换")
                        .fontSize(13)
                        .fontColor(Color.Gray)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    .onClick(() => {
                      this.newAvatarVal = this.currentUserAvatar;
                      this.avatarModalVisible = true;
                    })

                    // Theme selector option
                    Column() {
                      Text("🎨 个性化主题配色")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .width("100%")
                        .margin({ bottom: 8 })
                      
                      Row({ space: 10 }) {
                        ForEach([
                          { name: "海蓝", color: "#1565C0" },
                          { name: "翡绿", color: "#2E7D32" },
                          { name: "珊瑚", color: "#C62828" },
                          { name: "高雅紫", color: "#6A1B9A" },
                          { name: "活力橙", color: "#EF6C00" },
                          { name: "夜黑", color: "#37474F" }
                        ], (theme: Record<string, string>) => {
                          Column() {
                            Circle()
                              .width(26)
                              .height(26)
                              .fill(theme.color)
                              .border({ width: this.themeColor === theme.color ? 2 : 0, color: Color.Black })
                            Text(theme.name)
                              .fontSize(10)
                              .fontColor(Color.Gray)
                              .margin({ top: 4 })
                          }
                          .onClick(() => {
                            this.themeColor = theme.color;
                            this.saveLocalSettings();
                          })
                        })
                      }
                      .width("100%")
                      .justifyContent(FlexAlign.SpaceBetween)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)

                    // Change Password option
                    Row() {
                      Text("🔐 修改安全账户密码")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .layoutWeight(1)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    .onClick(() => {
                      this.changePasswordModalVisible = true;
                    })

                    // Settings screen shortcut
                    Row() {
                      Text("⚙️ 调试与服务器接口配置")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .layoutWeight(1)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    .onClick(() => {
                      this.screenState = "SETTINGS";
                    })

                    // Logout button
                    Button("退出登录")
                      .width("100%")
                      .height(45)
                      .backgroundColor(Color.Red)
                      .margin({ top: 15 })
                      .onClick(() => {
                        this.closeWebSocket();
                        this.token = "";
                        this.currentUsername = "";
                        this.currentUserNickname = "";
                        this.currentUserAvatar = "";
                        this.saveLocalSettings();
                        this.screenState = "LOGIN";
                      })
                  }
                  .padding(16)
                  .width("100%")
                }
                .width("100%")
                .height("100%")
              }.tabBar(this.TabBuilder("设置中心", 3, "⚙️"))
            }
            .layoutWeight(1)
            .width("100%")
            .onChange((idx: number) => {
              this.activeTabIndex = idx;
            })
          }
          .width("100%")
          .height("100%")
          .backgroundColor("#F5F7FA")

        } else if (this.screenState === "CHAT") {
          // --- CHAT SCREEN ---
          Column() {
            // Chat header with back button
            Row() {
              Row() {
                Text("⬅️ 返回")
                  .fontSize(15)
                  .fontColor(this.themeColor)
                  .fontWeight(FontWeight.Medium)
              }
              .padding({ left: 16, right: 16 })
              .onClick(() => {
                this.screenState = "MAIN";
              })
              
              Column() {
                Text(this.activeChatTitle)
                  .fontSize(16)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(Color.Black)
                
                if (this.typingIndicator) {
                  Text(this.typingIndicator)
                    .fontSize(11)
                    .fontColor(this.themeColor)
                    .margin({ top: 2 })
                }
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Center)

              if (this.activeTargetUser && this.activeTargetUser !== "filehelper") {
                Text("删除好友")
                  .fontSize(13)
                  .fontColor(Color.Red)
                  .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                  .border({ width: 1, color: Color.Red, radius: 4 })
                  .margin({ right: 16 })
                  .onClick(() => {
                    promptAction.showDialog({
                      title: "删除好友确认",
                      message: `确定要删除好友 @${this.activeTargetUser} 吗？删除后双方将无法发送私信。`,
                      buttons: [
                        { text: "取消", color: "#808080" },
                        { text: "确认删除", color: "#FF3B30" }
                      ]
                    }, (dialogErr: BusinessError, dialogData: promptAction.ShowDialogSuccessResponse) => {
                      if (!dialogErr && dialogData.index === 1) {
                        this.deleteFriendApi(this.activeTargetUser);
                      }
                    });
                  })
              } else {
                Text("")
                  .width(60)
                  .margin({ right: 16 })
              }
            }
            .width("100%")
            .height(56)
            .backgroundColor("#F5F7FA")
            .border({ width: { bottom: 1 }, color: "#E0E0E0" })
            .alignItems(VerticalAlign.Center)

            // Chat Messages Stream
            List({ scroller: this.scroller }) {
              ForEach(this.messages, (msg: Message) => {
                ListItem() {
                  Row() {
                    if (msg.name !== this.currentUsername) {
                      // Avatar on left
                      if (msg.name === "filehelper") {
                        Text("📁")
                          .fontSize(18)
                          .textAlign(TextAlign.Center)
                          .width(36)
                          .height(36)
                          .borderRadius(18)
                          .backgroundColor("#E0F2F1")
                          .fontColor("#00796B")
                          .margin({ right: 8, top: 4 })
                      } else if (msg.avatar && msg.avatar.trim().length > 0) {
                        Image(msg.avatar.startsWith("data:image") ? msg.avatar : (msg.avatar.startsWith("http") ? msg.avatar : `${this.serverUrl}${msg.avatar.startsWith('/') ? '' : '/'}${msg.avatar}`))
                          .width(36)
                          .height(36)
                          .borderRadius(18)
                          .objectFit(ImageFit.Cover)
                          .margin({ right: 8, top: 4 })
                          .onClick(() => {
                            this.showUserAvatarPreview(msg.nickname || msg.name, msg.name, msg.avatar || "");
                          })
                      } else {
                        Text((msg.nickname || msg.name || "U").substring(0, 1).toUpperCase())
                          .fontSize(14)
                          .fontWeight(FontWeight.Bold)
                          .fontColor(Color.White)
                          .textAlign(TextAlign.Center)
                          .width(36)
                          .height(36)
                          .borderRadius(18)
                          .backgroundColor(this.getAvatarBgColor(msg.name))
                          .margin({ right: 8, top: 4 })
                          .onClick(() => {
                            this.showUserAvatarPreview(msg.nickname || msg.name, msg.name, "");
                          })
                      }
                    }

                    Column() {
                      Row() {
                        Text(`${msg.nickname} (@${msg.name})`)
                          .fontSize(10)
                          .fontColor(Color.Gray)
                      }
                      .margin({ bottom: 2 })

                      Row() {
                        Column() {
                          if (msg.content === "[system_recalled]") {
                            Text(msg.name === this.currentUsername ? "您撤回了一条消息" : `"${msg.nickname}" 撤回了一条消息`)
                              .fontSize(13)
                              .fontColor(Color.Gray)
                              .fontStyle(FontStyle.Italic)
                          } else if (msg.content.startsWith("[img:") && msg.content.endsWith("]")) {
                            Image(msg.content.substring(5, msg.content.length - 1).startsWith("http") ? 
                              msg.content.substring(5, msg.content.length - 1) : 
                              `${this.serverUrl}${msg.content.substring(5, msg.content.length - 1)}`
                            )
                              .width(180)
                              .height(180)
                              .objectFit(ImageFit.Contain)
                              .borderRadius(6)
                              .onClick(() => {
                                this.previewImageUrl = msg.content.substring(5, msg.content.length - 1).startsWith("http") ? 
                                  msg.content.substring(5, msg.content.length - 1) : 
                                  `${this.serverUrl}${msg.content.substring(5, msg.content.length - 1)}`;
                              })
                          } else if (msg.content.startsWith("[file:") && msg.content.endsWith("]")) {
                            Row() {
                              Text("📎")
                                .fontSize(22)
                                .margin({ right: 8 })
                              Column() {
                                Text(msg.content.substring(6, msg.content.length - 1).indexOf('|') !== -1 ?
                                  msg.content.substring(6, msg.content.length - 1).substring(msg.content.substring(6, msg.content.length - 1).indexOf('|') + 1) :
                                  msg.content.substring(6, msg.content.length - 1).substring(msg.content.substring(6, msg.content.length - 1).lastIndexOf('/') + 1)
                                )
                                  .fontSize(14)
                                  .fontWeight(FontWeight.Bold)
                                  .fontColor(msg.name === this.currentUsername ? Color.White : Color.Black)
                                  .maxLines(1)
                                Text("点击打开链接下载")
                                  .fontSize(11)
                                  .fontColor(msg.name === this.currentUsername ? "#E0E0E0" : Color.Gray)
                                  .margin({ top: 2 })
                              }
                              .alignItems(HorizontalAlign.Start)
                            }
                            .alignItems(VerticalAlign.Center)
                            .onClick(() => {
                              let raw = msg.content.substring(6, msg.content.length - 1);
                              let pipeIdx = raw.indexOf('|');
                              let fileUrl = pipeIdx !== -1 ? raw.substring(0, pipeIdx) : raw;
                              let filename = pipeIdx !== -1 ? raw.substring(pipeIdx + 1) : raw.substring(raw.lastIndexOf('/') + 1);
                              let fullUrl = fileUrl.startsWith("http") ? fileUrl : `${this.serverUrl}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
                              this.showFileDownloadOptions(filename, fullUrl);
                            })
                          } else if (msg.content.startsWith("[user_card:") && msg.content.endsWith("]")) {
                            Text("📇 [好友名片]")
                              .fontSize(14)
                              .fontColor(Color.Orange)
                          } else {
                            Text(msg.content)
                              .fontSize(14)
                              .fontColor(msg.name === this.currentUsername ? Color.White : Color.Black)
                          }
                        }
                        .padding(10)
                        .backgroundColor(msg.content === "[system_recalled]" ? "#F0F0F0" : (msg.name === this.currentUsername ? this.themeColor : "#E0E0E0"))
                        .borderRadius(8)
                        .gesture(
                          LongPressGesture({ repeat: false })
                            .onAction(() => {
                              if (msg.content !== "[system_recalled]") {
                                this.showMsgActions(msg);
                              }
                            })
                        )
                      }
                    }
                    .alignItems(msg.name === this.currentUsername ? HorizontalAlign.End : HorizontalAlign.Start)
                    .layoutWeight(1)

                    if (msg.name === this.currentUsername) {
                      // Avatar on right
                      if (msg.avatar && msg.avatar.trim().length > 0) {
                        Image(msg.avatar.startsWith("data:image") ? msg.avatar : (msg.avatar.startsWith("http") ? msg.avatar : `${this.serverUrl}${msg.avatar.startsWith('/') ? '' : '/'}${msg.avatar}`))
                          .width(36)
                          .height(36)
                          .borderRadius(18)
                          .objectFit(ImageFit.Cover)
                          .margin({ left: 8, top: 4 })
                          .onClick(() => {
                            this.showUserAvatarPreview(msg.nickname || msg.name, msg.name, msg.avatar || "");
                          })
                      } else {
                        Text((msg.nickname || msg.name || "U").substring(0, 1).toUpperCase())
                          .fontSize(14)
                          .fontWeight(FontWeight.Bold)
                          .fontColor(Color.White)
                          .textAlign(TextAlign.Center)
                          .width(36)
                          .height(36)
                          .borderRadius(18)
                          .backgroundColor(this.getAvatarBgColor(msg.name))
                          .margin({ left: 8, top: 4 })
                          .onClick(() => {
                            this.showUserAvatarPreview(msg.nickname || msg.name, msg.name, "");
                          })
                      }
                    }
                  }
                  .width("100%")
                  .alignItems(VerticalAlign.Top)
                  .padding({ left: 16, right: 16, top: 6, bottom: 6 })
                }
              })
            }
            .width("100%")
            .layoutWeight(1)
            .backgroundColor("#FAFAFA")

            // Quick Emoji Picker Bar
            Row() {
              List() {
                ForEach(this.quickEmojis, (emoji: string) => {
                  ListItem() {
                    Text(emoji)
                      .fontSize(22)
                      .padding(6)
                      .onClick(() => {
                        this.msgInput += emoji;
                        this.triggerTyping();
                      })
                  }
                })
              }
              .listDirection(Axis.Horizontal)
              .width("100%")
              .height(38)
            }
            .backgroundColor("#F5F7FA")
            .border({ width: { top: 1, bottom: 1 }, color: "#E8E8E8" })

            // Chat bottom input panel
            Row() {
              TextInput({ text: this.msgInput, placeholder: "说点什么吧..." })
                .layoutWeight(1)
                .height(42)
                .fontColor(Color.Black)
                .placeholderColor(Color.Gray)
                .onChange((val: string) => {
                  this.msgInput = val;
                  this.triggerTyping();
                })
              
              Button("发送")
                .width(70)
                .height(42)
                .margin({ left: 10 })
                .backgroundColor(this.themeColor)
                .onClick(() => this.sendMessage())
            }
            .width("100%")
            .padding(10)
            .backgroundColor("#FFFFFF")
            .border({ width: { top: 1 }, color: "#E0E0E0" })
          }
          .width("100%")
          .height("100%")

        } else if (this.screenState === "ADD_FRIEND") {
          // --- ADD FRIEND SCREEN ---
          Column() {
            // Header with back button
            Row() {
              Row() {
                Text("⬅️ 返回")
                  .fontSize(15)
                  .fontColor(this.themeColor)
                  .fontWeight(FontWeight.Medium)
              }
              .padding({ left: 16, right: 16 })
              .onClick(() => {
                this.screenState = "MAIN";
              })
              
              Text("添加好友 / 申请列表")
                .fontSize(16)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.Black)
                .layoutWeight(1)
                .textAlign(TextAlign.Center)
                .margin({ right: 60 })
            }
            .width("100%")
            .height(56)
            .backgroundColor("#F5F7FA")
            .border({ width: { bottom: 1 }, color: "#E0E0E0" })
            .alignItems(VerticalAlign.Center)

            // Content Container
            Column({ space: 15 }) {
              // Section 1: User Search
              Column() {
                Text("🔍 查找新朋友")
                  .fontSize(15)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(Color.Black)
                  .width("100%")
                  .margin({ bottom: 8 })

                Row() {
                  TextInput({ text: this.searchQuery, placeholder: "输入用户名或昵称搜索..." })
                    .layoutWeight(1)
                    .height(40)
                    .fontColor(Color.Black)
                    .placeholderColor(Color.Gray)
                    .onChange((val: string) => this.searchQuery = val)

                  Button("搜索")
                    .width(70)
                    .height(40)
                    .margin({ left: 10 })
                    .backgroundColor(this.themeColor)
                    .onClick(() => this.searchUsers())
                }
                .width("100%")

                // Search Results List
                List() {
                  ForEach(this.searchResults, (user: SearchedUserItem) => {
                    ListItem() {
                      Row() {
                        Text(user.nickname ? `${user.nickname} (@${user.username})` : `@${user.username}`)
                          .fontSize(14)
                          .fontColor(Color.Black)
                          .layoutWeight(1)

                        if (user.is_friend) {
                          Text("已是好友")
                            .fontSize(13)
                            .fontColor(Color.Gray)
                            .padding({ left: 10, right: 10 })
                        } else if (user.request_status === "pending") {
                          Text(user.request_direction === "sent" ? "已发送申请" : "待同意")
                            .fontSize(13)
                            .fontColor(user.request_direction === "sent" ? Color.Gray : Color.Orange)
                            .padding({ left: 10, right: 10 })
                        } else {
                          Button("➕ 加好友")
                            .fontSize(12)
                            .height(30)
                            .backgroundColor("#4CAF50")
                            .onClick(() => this.sendRequest(user.username))
                        }
                      }
                      .width("100%")
                      .padding({ top: 10, bottom: 10 })
                      .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                    }
                  })
                }
                .width("100%")
                .layoutWeight(1)
                .margin({ top: 10 })
              }
              .width("92%")
              .layoutWeight(1)
              .padding(15)
              .backgroundColor(Color.White)
              .borderRadius(8)

              // Section 2: Friend Requests List
              Column() {
                Text("🔔 收到的好友申请")
                  .fontSize(15)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(Color.Black)
                  .width("100%")
                  .margin({ bottom: 8 })

                if (this.incomingRequests.length === 0) {
                  Text("暂无挂起的好友申请")
                    .fontSize(13)
                    .fontColor(Color.Gray)
                    .width("100%")
                    .textAlign(TextAlign.Center)
                    .margin({ top: 20, bottom: 20 })
                } else {
                  List() {
                    ForEach(this.incomingRequests, (req: IncomingRequestItem) => {
                      ListItem() {
                        Row() {
                          Text(req.nickname ? `${req.nickname} (@${req.from_user})` : `@${req.from_user}`)
                            .fontSize(14)
                            .fontColor(Color.Black)
                            .layoutWeight(1)

                          Row({ space: 8 }) {
                            Button("同意")
                              .fontSize(11)
                              .height(26)
                              .backgroundColor("#4CAF50")
                              .onClick(() => this.respondRequest(req.from_user, "accept"))

                            Button("拒绝")
                              .fontSize(11)
                              .height(26)
                              .backgroundColor(Color.Red)
                              .onClick(() => this.respondRequest(req.from_user, "reject"))
                          }
                        }
                        .width("100%")
                        .padding({ top: 8, bottom: 8 })
                        .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                      }
                    })
                  }
                  .width("100%")
                }
              }
              .width("92%")
              .layoutWeight(1)
              .padding(15)
              .backgroundColor(Color.White)
              .borderRadius(8)
            }
            .width("100%")
            .layoutWeight(1)
            .backgroundColor("#FAFAFA")
            .padding({ top: 15, bottom: 15 })
            .alignItems(HorizontalAlign.Center)
          }
          .width("100%")
          .height("100%")

        } else if (this.screenState === "SETTINGS") {
          // --- SETTINGS SCREEN ---
          Column() {
            // Header with back button
            Row() {
              Row() {
                Text("⬅️ 返回")
                  .fontSize(15)
                  .fontColor(this.themeColor)
                  .fontWeight(FontWeight.Medium)
              }
              .padding({ left: 16, right: 16 })
              .onClick(() => {
                this.screenState = "MAIN";
              })
              
              Text("配置调试中心")
                .fontSize(16)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.Black)
                .layoutWeight(1)
                .textAlign(TextAlign.Center)
                .margin({ right: 60 })
            }
            .width("100%")
            .height(56)
            .backgroundColor("#F5F7FA")
            .border({ width: { bottom: 1 }, color: "#E0E0E0" })
            .alignItems(VerticalAlign.Center)

            // Content
            Column({ space: 20 }) {
              Column({ space: 8 }) {
                Text("🌐 API 服务器地址")
                  .fontSize(14)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(Color.Black)
                  .width("100%")

                TextInput({ text: this.serverUrl, placeholder: "http://..." })
                  .width("100%")
                  .height(45)
                  .fontColor(Color.Black)
                  .placeholderColor(Color.Gray)
                  .onChange((val: string) => {
                    this.serverUrl = val;
                    this.saveLocalSettings();
                  })
              }
              .width("100%")

              Column({ space: 8 }) {
                Text("⚡ WebSocket 服务器地址")
                  .fontSize(14)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(Color.Black)
                  .width("100%")

                TextInput({ text: this.wsUrl, placeholder: "ws://..." })
                  .width("100%")
                  .height(45)
                  .fontColor(Color.Black)
                  .placeholderColor(Color.Gray)
                  .onChange((val: string) => {
                    this.wsUrl = val;
                    this.saveLocalSettings();
                  })
              }
              .width("100%")

              Column({ space: 10 }) {
                Button("清除所有本地置顶及缓存设置")
                  .width("100%")
                  .height(45)
                  .backgroundColor("#FF9500")
                  .onClick(() => {
                    this.pinnedChats = [];
                    this.lastMessages = {};
                    this.unreadCounts = {};
                    this.saveLocalSettings();
                    promptAction.showToast({ message: "已重置并清除缓存" });
                  })
              }
              .width("100%")
              .margin({ top: 20 })

              // About section
              Column({ space: 5 }) {
                Text("信语 (OpenBoard) NEXT")
                  .fontSize(16)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(Color.Black)
                
                Text("版本号: 6.0.0 (Release)")
                  .fontSize(13)
                  .fontColor(Color.Gray)
                
                Text("基于 HarmonyOS NEXT SDK 原生开发")
                  .fontSize(12)
                  .fontColor(Color.Gray)
              }
              .width("100%")
              .alignItems(HorizontalAlign.Center)
              .margin({ top: 40 })
            }
            .width("90%")
            .margin({ top: 20 })
          }
          .width("100%")
          .height("100%")
          .backgroundColor("#FAFAFA")
        }
      }
      .width("100%")
      .height("100%")

      // --- FLOATING ACTION BUTTON (FAB) ---
      // Only display FAB on lists tabs (activeTabIndex < 3) when in MAIN view
      if (this.activeTabIndex < 3 && this.screenState === "MAIN") {
        Button() {
          Text("＋")
            .fontSize(28)
            .fontColor(Color.White)
            .fontWeight(FontWeight.Bold)
        }
        .width(56)
        .height(56)
        .backgroundColor(this.themeColor)
        .borderRadius(28)
        .position({ x: "82%", y: "80%" })
        .shadow({ radius: 8, color: "#40000000" })
        .onClick(() => {
          this.showFabMenu();
        })
      }

      // --- IMAGE PREVIEW OVERLAY ---
      if (this.previewImageUrl) {
        Column() {
          Image(this.previewImageUrl)
            .width("100%")
            .height("100%")
            .objectFit(ImageFit.Contain)
            .onClick(() => {
              this.previewImageUrl = "";
            })
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#E0000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: CREATE GROUP ---
      if (this.createGroupModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("👥 新建群聊")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            TextInput({ text: this.newGroupName, placeholder: "请输入群聊名称" })
              .width("100%")
              .height(42)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.newGroupName = val)

            Row({ space: 15 }) {
              Button("取消")
                .backgroundColor(Color.Gray)
                .layoutWeight(1)
                .onClick(() => {
                  this.createGroupModalVisible = false;
                  this.newGroupName = "";
                })
              
              Button("创建")
                .backgroundColor(this.themeColor)
                .layoutWeight(1)
                .onClick(() => {
                  this.createGroupApi();
                })
            }
          }
          .width("80%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(10)
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: EDIT NICKNAME ---
      if (this.nicknameModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("✍️ 修改个性昵称")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            TextInput({ text: this.newNicknameVal, placeholder: "请输入新昵称" })
              .width("100%")
              .height(42)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.newNicknameVal = val)

            Row({ space: 15 }) {
              Button("取消")
                .backgroundColor(Color.Gray)
                .layoutWeight(1)
                .onClick(() => {
                  this.nicknameModalVisible = false;
                  this.newNicknameVal = "";
                })
              
              Button("确定")
                .backgroundColor(this.themeColor)
                .layoutWeight(1)
                .onClick(() => {
                  this.updateNicknameApi();
                })
            }
          }
          .width("80%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(10)
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: CHANGE PASSWORD ---
      if (this.changePasswordModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("🔐 修改安全账户密码")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            TextInput({ text: this.oldPasswordInput, placeholder: "请输入原密码" })
              .type(InputType.Password)
              .width("100%")
              .height(42)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.oldPasswordInput = val)

            TextInput({ text: this.newPasswordInput, placeholder: "请输入新密码" })
              .type(InputType.Password)
              .width("100%")
              .height(42)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.newPasswordInput = val)

            Row({ space: 15 }) {
              Button("取消")
                .backgroundColor(Color.Gray)
                .layoutWeight(1)
                .onClick(() => {
                  this.changePasswordModalVisible = false;
                  this.oldPasswordInput = "";
                  this.newPasswordInput = "";
                })
              
              Button("确认修改")
                .backgroundColor(this.themeColor)
                .layoutWeight(1)
                .onClick(() => {
                  this.changePasswordApi();
                })
            }
          }
          .width("80%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(10)
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: QR LOGIN CONFIRMATION ---
      if (this.qrLoginModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("🔐 网页端扫码登录测试")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            Text("请输入或粘贴网页端登录二维码包含的信息值 (e.g. openboard:qr_login:UUID)")
              .fontSize(12)
              .fontColor(Color.Gray)
              .width("100%")

            TextInput({ text: this.qrCodeInput, placeholder: "请输入二维码内容" })
              .width("100%")
              .height(42)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.qrCodeInput = val)

            Row({ space: 15 }) {
              Button("取消")
                .backgroundColor(Color.Gray)
                .layoutWeight(1)
                .onClick(() => {
                  this.qrLoginModalVisible = false;
                  this.qrCodeInput = "";
                })
              
              Button("校验并授权")
                .backgroundColor(this.themeColor)
                .layoutWeight(1)
                .onClick(() => {
                  this.processQrCodeInput();
                })
            }
          }
          .width("80%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(10)
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: USER PROFILE PREVIEW ---
      if (this.profilePreviewVisible) {
        Column() {
          Column({ space: 15 }) {
            // User Avatar (clickable to view in full-screen!)
            if (this.profilePreviewAvatar && this.profilePreviewAvatar.trim().length > 0) {
              Image(this.profilePreviewAvatar.startsWith("data:image") ? this.profilePreviewAvatar : (this.profilePreviewAvatar.startsWith("http") ? this.profilePreviewAvatar : `${this.serverUrl}${this.profilePreviewAvatar.startsWith('/') ? '' : '/'}${this.profilePreviewAvatar}`))
                .width(100)
                .height(100)
                .borderRadius(50)
                .objectFit(ImageFit.Cover)
                .onClick(() => {
                  // View full screen image!
                  this.previewImageUrl = this.profilePreviewAvatar.startsWith("data:image") ? this.profilePreviewAvatar : (this.profilePreviewAvatar.startsWith("http") ? this.profilePreviewAvatar : `${this.serverUrl}${this.profilePreviewAvatar.startsWith('/') ? '' : '/'}${this.profilePreviewAvatar}`);
                })
            } else {
              Text(this.profilePreviewNickname.substring(0, 1).toUpperCase())
                .fontSize(36)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.White)
                .textAlign(TextAlign.Center)
                .width(100)
                .height(100)
                .borderRadius(50)
                .backgroundColor(this.getAvatarBgColor(this.profilePreviewUser))
            }

            Text(this.profilePreviewNickname)
              .fontSize(20)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            Text(`@${this.profilePreviewUser}`)
              .fontSize(14)
              .fontColor(Color.Gray)
            
            Row({ space: 12 }) {
              if (this.profilePreviewUser !== this.currentUsername) {
                if (this.profilePreviewIsFriend) {
                  Button("❌ 删除好友")
                    .layoutWeight(1)
                    .height(40)
                    .backgroundColor("#FF3B30")
                    .onClick(() => {
                      this.profilePreviewVisible = false;
                      promptAction.showDialog({
                        title: "删除好友确认",
                        message: `确定要删除好友 @${this.profilePreviewUser} 吗？`,
                        buttons: [
                          { text: "取消", color: "#808080" },
                          { text: "确认删除", color: "#FF3B30" }
                        ]
                      }, (dialogErr: BusinessError, dialogData: promptAction.ShowDialogSuccessResponse) => {
                        if (!dialogErr && dialogData.index === 1) {
                          this.deleteFriendApi(this.profilePreviewUser);
                        }
                      });
                    })
                } else {
                  Button("➕ 添加好友")
                    .layoutWeight(1)
                    .height(40)
                    .backgroundColor(this.themeColor)
                    .onClick(() => {
                      this.profilePreviewVisible = false;
                      this.sendRequest(this.profilePreviewUser);
                    })
                }
              }
              
              Button("关闭")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(Color.Gray)
                .onClick(() => {
                  this.profilePreviewVisible = false;
                })
            }
            .width("100%")
            .margin({ top: 10 })
          }
          .width("80%")
          .padding(24)
          .backgroundColor(Color.White)
          .borderRadius(16)
          .shadow({ radius: 10, color: "#20000000" })
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: EDIT AVATAR ---
      if (this.avatarModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("👤 修改个人头像")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            // Avatar Preview
            if (this.newAvatarVal && this.newAvatarVal.trim().length > 0) {
              Image(this.newAvatarVal.startsWith("data:image") ? this.newAvatarVal : (this.newAvatarVal.startsWith("http") ? this.newAvatarVal : `${this.serverUrl}${this.newAvatarVal.startsWith('/') ? '' : '/'}${this.newAvatarVal}`))
                .width(80)
                .height(80)
                .borderRadius(40)
                .objectFit(ImageFit.Cover)
                .alignSelf(ItemAlign.Center)
            } else {
              Text(this.currentUserNickname.substring(0, 1).toUpperCase())
                .fontSize(28)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.White)
                .textAlign(TextAlign.Center)
                .width(80)
                .height(80)
                .borderRadius(40)
                .backgroundColor(this.themeColor)
                .alignSelf(ItemAlign.Center)
            }
            
            Button("🖼️ 从手机图库选择图片")
              .width("100%")
              .height(40)
              .backgroundColor(this.themeColor)
              .onClick(() => {
                this.selectAvatarFromGallery();
              })

            TextInput({ text: this.newAvatarVal, placeholder: "或输入网络图片URL/Base64" })
              .width("100%")
              .height(45)
              .onChange((val: string) => this.newAvatarVal = val)

            Row({ space: 12 }) {
              Button("取消")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(Color.Gray)
                .onClick(() => {
                  this.avatarModalVisible = false;
                  this.newAvatarVal = "";
                })

              Button("保存")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(this.themeColor)
                .onClick(() => {
                  this.updateAvatarApi();
                })
            }
            .width("100%")
            .margin({ top: 10 })
          }
          .width("80%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(10)
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }
    }
    .width("100%")
    .height("100%")
  }
}