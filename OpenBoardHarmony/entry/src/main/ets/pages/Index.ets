import http from '@ohos.net.http';
import webSocket from '@ohos.net.webSocket';
import promptAction from '@ohos.promptAction';
import dataPreferences from '@ohos.data.preferences';
import pasteboard from '@ohos.pasteboard';
import common from '@ohos.app.ability.common';
import Want from '@ohos.app.ability.Want';
import picker from '@ohos.file.picker';
import fs from '@ohos.file.fs';
import request from '@ohos.request';
import { BusinessError } from '@ohos.base';
import cameraPicker from '@ohos.multimedia.cameraPicker';
import camera from '@ohos.multimedia.camera';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { RGBLuminanceSource, BinaryBitmap, HybridBinarizer, MultiFormatReader, DecodeHintType, BarcodeFormat } from '@ohos/zxing';
import image from '@ohos.multimedia.image';
import web_webview from '@ohos.web.webview';

interface Message {
  id?: number;
  name: string;
  nickname: string;
  content: string;
  time: string;
  room_id: number;
  isRecalled?: number;
  avatar?: string;
  can_recall?: boolean;
  can_edit?: boolean;
  edited?: boolean;
  edited_at?: string;
  read_count?: number;
  client_id?: string;
  delivery_status?: string;
}

interface Relation {
  id: number;
  name: string;
  type: string; // "group" or "friend"
  targetUser?: string;
  avatar?: string;
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
  pagination?: HistoryPagination;
}

interface HistoryPagination {
  has_more?: boolean;
  next_before_id?: number;
}

interface WsMsgData {
  id?: number;
  name: string;
  nickname: string;
  content: string;
  time: string;
  room_id: number;
  avatar?: string;
  receiver?: string;
  can_recall?: boolean;
  can_edit?: boolean;
  read_count?: number;
  client_id?: string;
}

interface WsMsg {
  type: string;
  data?: WsMsgData;
  name?: string;
  user?: string;
  nickname?: string;
  content?: string;
  time?: string;
  room_id?: number;
  from_user?: string;
  from_nickname?: string;
  msg_id?: number;
  avatar?: string;
  receiver?: string;
}

interface SendMsgPayload {
  content: string;
  room_id: number;
  receiver?: string;
  client_id?: string;
}

interface ForwardMsgPayload {
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

const EMOJI_CATEGORIES: Record<string, string[]> = {
  "❤️ 收藏": [],
  "😀 表情": ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🤭", "🤫", "🤥", "😶", "😐", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕"],
  "👤 人物": ["👋", "🤚", "🖐️", "✋", "🖖", "👌", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🦷", "🦴", "👀", "👁️", "👅", "👄", "💋", "🩸"],
  "🐱 动物": ["🙈", "🙉", "🙊", "💥", "💫", "💦", "💨", "🐵", "🐒", "🦍", "🦧", "🐶", "🐕", "🦮", "🐩", "🐺", "🦊", "🦝", "🐱", "🐈", "🦁", "🐯", "🐅", "🐆", "🐴", "🐎", "🦄", "🦓", "🦌", "🐮", "🐂", "🐃", "🐄", "🐷", "🐖", "🐗", "🐽", "🐏", "🐑", "🐐", "🐪", "🐫", "🦒", "🐘", "🦏", "🦛", "🐭", "🐁", "🐀", "打地鼠", "🐰", "🐇", "🐿️", "🦔", "🦇", "🐻", "🐨", "🐼", "🦥", "🦦", "🦖", "🦕"],
  "🍔 食物": ["🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆", "🥑", "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🥔", "🍠", "🥐", "面包", "🥖", "🥨", "🧀", "🍳", "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🌭", "🍔", "🍟", "🍕", "🥪", "🥙", "🌮", "🌯", "🥗", "🥘", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟", "🍤", "🍙", "🍚", "🍘", "🍢", "🍡", "🍧", "🍨", "🍦", "🥧", "蛋糕", "🎂", "🍮", "甜甜圈", "🍩", "🍪", "🌰", "🥜", "🍯"],
  "🚗 出行": ["🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐", "🛻", "🚚", "🚛", "🚜", "🛵", "🏍️", "🛺", "🚲", "🛴", "🛹", "🚏", "卫星", "🚀", "🛸", "直升机", "🛶", "⛵", "游艇", "🛳️", "⛴️", "🚢", "✈️", "上升", "降落", "地图", "🏔️", "⛰️", "火山", "🗻", "帐篷", "沙滩", "沙漠", "岛屿", "城市", "城堡", "日式", "体育馆", "摩天轮", "过山车", "东京铁塔", "自由女神", "喷泉"],
  "🎮 活动": ["⚽", "🏀", "🏈", "⚾", "🥎", "玩球", "排球", "橄榄球", "飞盘", "台球", "溜溜球", "乒乓", "羽毛球", "冰球", "曲棍球", "长曲棍球", "弓箭", "钓鱼", "潜水", "拳套", "武术", "滑冰", "滑雪", "雪橇", "冰壶", "飞镖", "手风琴", "游戏机", "摇杆", "拉霸", "骰子", "拼图", "保龄球", "面具", "调色板", "场记板", "麦克风", "耳机", "五线谱", "钢琴", "鼓", "萨克斯", "喇叭", "吉他", "小提琴"],
  "💡 物品": ["⌚", "📱", "📲", "电脑", "键盘", "显示器", "打印机", "鼠标", "💾", "💿", "相机", "📸", "摄像机", "电影", "投影机", "底片", "电话", "传呼", "传真", "电视", "收音", "麦克", "调音台", "旋钮", "指南针", "秒表", "时钟", "沙漏", "电池", "插头", "电灯", "手电", "蜡烛", "垃圾桶", "油桶", "美金", "硬币", "信用卡", "钻石", "天平", "扳手", "锤子", "工具", "锯", "镐", "斧头", "螺丝", "齿轮", "盾牌", "十字", "炸带", "螺丝刀"],
  "🔣 符号": ["💘", "💝", "💖", "💗", "💓", "💞", "💕", "💟", "❣️", "💔", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "美观", "花札", "红中", "大王", "花朵", "旋风", "睡觉", "ATM", "洗手间", "残疾", "停车", "电梯", "男厕", "女厕", "婴儿", "无性别", "公共卫生", "垃圾箱", "电影院", "信号", "日本", "空余", "免费", "禁止", "合格", "满员", "折扣", "营业", "得"],
  "🚩 旗帜": ["🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️", "🇨🇳", "🇭🇰", "🇲🇴", "🇹🇼", "🇺🇸", "🇬🇧", "🇯🇵", "🇰🇷", "🇩🇪", "🇫🇷", "🇷🇺", "🇮🇹", "🇨🇦", "🇦🇺", "🇸🇬", "🇲🇾", "🇪🇸", "🇧🇷", "🇮🇳", "🇿🇦"]
};

@Entry
@Component
struct Index {
  @State screenState: string = "LOGIN"; // LOGIN, MAIN, CHAT, ADD_FRIEND, SETTINGS
  @State activeTabIndex: number = 0; // 0:聊天, 1:设置
  @State themeColor: string = "#1565C0"; // Dynamic Theme Accent color

  // Server config
  @State serverUrl: string = "https://liuyan.luojunqi.xyz";
  @State wsUrl: string = "wss://liuyan.luojunqi.xyz";
  
  // Auth inputs
  @State usernameInput: string = "";
  @State passwordInput: string = "";
  @State nicknameInput: string = "";
  @State isRegisterMode: boolean = false;
  @State showServerSettings: boolean = false;
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
  @State hasMoreHistory: boolean = true;
  private oldestMessageId: number = 0;
  private isLoadingHistory: boolean = false;
  @State msgInput: string = "";
  @State relations: Relation[] = [];
  
  // Typing state
  @State typingIndicator: string = "";
  private lastTypingTime: number = 0;
  private typingTimer: number = 0;

  // Search & Friend requests state
  @State searchQuery: string = "";
  @State chatSearchQuery: string = "";
  @State searchResults: SearchedUserItem[] = [];
  @State incomingRequests: IncomingRequestItem[] = [];

  @State localSearchQuery: string = "";
  @State qrScanModalVisible: boolean = false;
  @State qrScanInputVal: string = "";

  @State activeEmojiCategory: string = "😀 表情";
  @State favoriteEmojis: string[] = [];
  @State isEmojiPickerVisible: boolean = false;
  @State emojiCategories: Record<string, string[]> = EMOJI_CATEGORIES;
  @State emojiCategoryNames: string[] = ["❤️ 收藏", "😀 表情", "👤 人物", "🐱 动物", "🍔 食物", "🚗 出行", "🎮 活动", "💡 物品", "🔣 符号", "🚩 旗帜"];

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

  @State devicesModalVisible: boolean = false;
  @State activeDevicesList: Record<string, string | boolean>[] = [];
  @State gameCenterVisible: boolean = false;
  private webviewController: web_webview.WebviewController = new web_webview.WebviewController();

  @State changePasswordModalVisible: boolean = false;
  @State oldPasswordInput: string = "";
  @State newPasswordInput: string = "";

  @State qrLoginModalVisible: boolean = false;
  @State qrCodeInput: string = "";

  @State blacklistModalVisible: boolean = false;
  @State cardModalVisible: boolean = false;
  @State forwardModalVisible: boolean = false;
  @State forwardMessageId: number = 0;
  private editingMessageId: number = 0;
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
      this.loadFavoriteEmojis();
    }
  }

  aboutToDisappear() {
    this.closeWebSocket();
  }

  // Load local settings from Preferences
  loadLocalSettings() {
    try {
      let pref = dataPreferences.getPreferencesSync(getContext(this), { name: "OpenBoardPref" });
      this.serverUrl = pref.getSync("serverUrl", "https://liuyan.luojunqi.xyz") as string;
      this.wsUrl = pref.getSync("wsUrl", "wss://liuyan.luojunqi.xyz") as string;
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
            if (dataObj.type === "message" && dataObj.data) {
              let msgData = dataObj.data;
              let msg: Message = {
                name: msgData.name || "",
                nickname: msgData.nickname || msgData.name || "",
                content: msgData.content || "",
                time: msgData.time || new Date().toISOString(),
                room_id: msgData.room_id || 0,
                avatar: msgData.avatar || "",
                can_recall: msgData.can_recall === true && msgData.name === this.currentUsername
              };
              
              let key = msg.room_id > 0 ? `group:${msg.room_id}` : `friend:${msg.name === this.currentUsername ? msgData.receiver : msg.name}`;
              
              // Extract snippet representation
              let snippet = msg.content;
              if (msg.content.startsWith("[img:")) snippet = "[图片]";
              else if (msg.content.startsWith("[file:")) snippet = "[文件]";
              else if (msg.content.startsWith("[user_card:")) snippet = "[名片]";
              this.lastMessages[key] = snippet;
              
              // Increment unread count if we are not actively in this screen
              let isCurrentActiveScreen = (this.screenState === "CHAT" && 
                (msg.room_id > 0 ? this.activeRoomId === msg.room_id : (this.activeTargetUser === msg.name || this.activeTargetUser === msgData.receiver)));
              
              if (!isCurrentActiveScreen) {
                this.unreadCounts[key] = (this.unreadCounts[key] || 0) + 1;
              }
              
              // Check if matches active screen
              let isMatchActive = false;
              if (msg.room_id > 0) {
                isMatchActive = (msg.room_id === this.activeRoomId);
              } else {
                isMatchActive = (this.activeRoomId === 0 && 
                  ((msg.name === this.activeTargetUser && msgData.receiver === this.currentUsername) ||
                   (msg.name === this.currentUsername && msgData.receiver === this.activeTargetUser)));
              }

              if (isMatchActive) {
                this.messages.push(msg);
                this.scrollToBottom();
              }
            } else if (dataObj.type === "typing") {
              // Show typing indicator if match
              let typingUser = dataObj.user || "";
              let isMyChat = (dataObj.room_id === this.activeRoomId && 
                (dataObj.room_id > 0 || typingUser === this.activeTargetUser));
              
              if (isMyChat && typingUser !== this.currentUsername) {
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
      if (this.token) {
        setTimeout(() => {
          if (this.token) {
            console.info("Reconnecting HarmonyOS WebSocket...");
            this.connectWebSocket();
          }
        }, 5000);
      }
    });

    this.ws.on('error', (err: BusinessError) => {
      console.error("HarmonyOS WebSocket Error: " + JSON.stringify(err));
      if (this.token) {
        setTimeout(() => {
          if (this.token) {
            console.info("Reconnecting HarmonyOS WebSocket after error...");
            this.connectWebSocket();
          }
        }, 5000);
      }
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
        { text: "📥 直接下载到手机", color: this.themeColor },
        { text: "🌐 浏览器打开下载", color: "#FF9800" },
        { text: "📋 复制下载链接", color: "#4CAF50" }
      ]
    }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
      if (!err) {
        if (data.index === 0) {
          this.downloadFileNatively(filename, url);
        } else if (data.index === 1) {
          this.openBrowserUrl(url);
        } else if (data.index === 2) {
          this.copyToClipboard(url);
        }
      }
    });
  }

  // Native background download via ohos.request
  downloadFileNatively(filename: string, url: string) {
    try {
      let context = getContext(this) as common.UIAbilityContext;
      let filesDir = context.filesDir;
      let localPath = `${filesDir}/${filename}`;
      
      // Delete existing to prevent collisions
      try {
        if (fs.accessSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      } catch (e) {
        // file doesn't exist
      }
      
      promptAction.showToast({ message: "正在开始后台下载..." });
      
      request.downloadFile(context, {
        url: url,
        filePath: localPath
      }).then((downloadTask: request.DownloadTask) => {
        downloadTask.on('complete', () => {
          promptAction.showDialog({
            title: "下载完成",
            message: `文件已成功下载到应用沙盒！\n名称: ${filename}\n路径: ${localPath}`,
            buttons: [
              { text: "确定", color: this.themeColor }
            ]
          });
        });
        
        downloadTask.on('fail', (errCode: number) => {
          promptAction.showToast({ message: `下载失败，错误码: ${errCode}` });
        });
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "创建下载任务失败" });
      });
    } catch(e) {
      promptAction.showToast({ message: "下载文件发生异常" });
    }
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

  fetchDevicesApi() {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/user/devices`,
      {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': this.token
        }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res: Record<string, Object> = JSON.parse(data.result as string);
            if (res.status === 'success' && res.data) {
              this.activeDevicesList = res.data as Record<string, string | boolean>[];
              this.devicesModalVisible = true;
            } else {
              promptAction.showToast({ message: "暂无设备列表" });
            }
          } catch (e) {
            promptAction.showToast({ message: "解析设备列表失败" });
          }
        } else {
          promptAction.showToast({ message: "获取设备失败" });
        }
      }
    );
  }

  logoutDeviceApi(deviceId: string) {
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/user/devices/${deviceId}/logout`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Authorization': this.token
        }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "该设备已强行下线" });
          this.fetchDevicesApi();
        } else {
          promptAction.showToast({ message: "下线操作失败" });
        }
      }
    );
  }

  // Get consistent hash color for avatars
  getAvatarBgColor(username: string): string {
    let name = username || "U";
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
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
    if (this.messages.length === 0) return;
    setTimeout(() => {
      try {
        this.scroller.scrollEdge(Edge.Bottom);
      } catch (e) {
        console.error("scrollToBottom error: scroller might not be bound yet");
      }
    }, 300);
  }

  // Load chat history
  loadHistory(loadOlder: boolean = false) {
    if (this.isLoadingHistory || (loadOlder && !this.hasMoreHistory)) return;
    this.isLoadingHistory = true;
    let apiPath = "";
    if (this.activeRoomId > 0) {
      apiPath = `${this.serverUrl}/api/messages?room_id=${this.activeRoomId}`;
    } else if (this.activeTargetUser) {
      apiPath = `${this.serverUrl}/api/messages?target_user=${this.activeTargetUser}`;
    } else {
      apiPath = `${this.serverUrl}/api/messages?room_id=0`;
    }
    apiPath += `&limit=50`;
    if (loadOlder && this.oldestMessageId > 0) {
      apiPath += `&before_id=${this.oldestMessageId}`;
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
            this.hasMoreHistory = res.pagination?.has_more === true;
            this.oldestMessageId = res.pagination?.next_before_id || (rawList.length > 0 && rawList[0].id ? rawList[0].id as number : 0);
            if (loadOlder) {
              let older: Message[] = rawList.filter((incoming: Message) => {
                return this.messages.findIndex((current: Message) => current.id === incoming.id) === -1;
              });
              this.messages = older.concat(this.messages);
              if (older.length > 0) {
                setTimeout((): void => {
                  this.scroller.scrollToIndex(older.length, false, ScrollAlign.START);
                }, 50);
              }
            } else {
              this.messages = rawList;
            }
            
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
            
            if (!loadOlder) this.scrollToBottom();
            if (this.messages.length > 0) {
              let latest = this.messages[this.messages.length - 1];
              if (latest.id) this.markMessagesRead(latest.id);
            }
          } catch (e) {
            console.error("Error parsing chat history");
          }
        }
        this.isLoadingHistory = false;
      }
    );
  }

  markMessagesRead(upToId: number) {
    let payload: Record<string, string | number> = {
      'up_to_id': upToId,
      'room_id': this.activeRoomId
    };
    if (this.activeTargetUser) payload['target_user'] = this.activeTargetUser;
    http.createHttp().request(
      `${this.serverUrl}/api/messages/read`,
      {
        method: http.RequestMethod.POST,
        header: { 'Authorization': this.token, 'Content-Type': 'application/json' },
        extraData: JSON.stringify(payload)
      },
      (): void => {}
    );
  }

  // Filter messages in current chat window based on search query
  getFilteredMessages(): Message[] {
    let query = this.chatSearchQuery.trim().toLowerCase();
    if (!query) {
      return this.messages;
    }
    return this.messages.filter((msg: Message) => {
      if (msg.content === "[system_recalled]") {
        return false;
      }
      let text = msg.content.toLowerCase();
      if (text.indexOf(query) !== -1) {
        return true;
      }
      if (msg.name && msg.name.toLowerCase().indexOf(query) !== -1) {
        return true;
      }
      if (msg.nickname && msg.nickname.toLowerCase().indexOf(query) !== -1) {
        return true;
      }
      return false;
    });
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
            grps = list.filter((g: GroupItem) => g.id !== 0).map((g: GroupItem): Relation => {
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
    if (!msg.id) return;
    let buttonsList: promptAction.Button[] = [
      { text: "📋 复制文本内容", color: "#4CAF50" },
      { text: "↗️ 转发消息", color: "#1677FF" },
      { text: "🔖 收藏消息", color: "#7C4DFF" }
    ];
    let isSticker = msg.content.startsWith("[img:") && msg.content.endsWith("]");
    let isEmoji = msg.content.trim().length <= 4;
    if (isSticker || isEmoji) {
      buttonsList.push({ text: "❤️ 收藏此表情", color: "#FF2D55" });
    }
    if (msg.name === this.currentUsername && msg.can_recall === true) {
      buttonsList.push({ text: "↩️ 撤回消息", color: "#FF3B30" });
    }
    if (msg.name === this.currentUsername && msg.can_edit === true) {
      buttonsList.push({ text: "✏️ 编辑消息", color: "#FF9800" });
    }
    
    promptAction.showActionMenu({
      title: "消息选项",
      buttons: buttonsList as [promptAction.Button, promptAction.Button?, promptAction.Button?, promptAction.Button?, promptAction.Button?, promptAction.Button?]
    }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
      if (!err) {
        let btnText = buttonsList[data.index].text;
        if (btnText === "📋 复制文本内容") {
          this.copyToClipboard(msg.content);
        } else if (btnText === "↗️ 转发消息" && msg.id) {
          this.forwardMessageId = msg.id;
          this.forwardModalVisible = true;
        } else if (btnText === "❤️ 收藏此表情") {
          this.addFavoriteEmoji(msg.content);
        } else if (btnText === "🔖 收藏消息" && msg.id) {
          this.favoriteMessageApi(msg.id);
        } else if (btnText === "↩️ 撤回消息" && msg.id) {
          this.recallMessageApi(msg.id);
        } else if (btnText === "✏️ 编辑消息" && msg.id) {
          this.editMessagePrompt(msg);
        }
      }
    });
  }

  getMessageImageUrl(content: string, thumbnail: boolean): string {
    let raw = content.substring(5, content.length - 1);
    let parts = raw.split('|');
    let selected = thumbnail && parts.length > 1 ? parts[1] : parts[0];
    return selected.startsWith("http") || selected.startsWith("data:image")
      ? selected
      : `${this.serverUrl}${selected.startsWith('/') ? '' : '/'}${selected}`;
  }

  favoriteMessageApi(msgId: number) {
    http.createHttp().request(
      `${this.serverUrl}/api/favorites/messages/${msgId}`,
      { method: http.RequestMethod.POST, header: { 'Authorization': this.token } },
      (err: BusinessError, data: http.HttpResponse) => {
        promptAction.showToast({ message: !err && data.responseCode === 200 ? "已收藏消息" : "收藏失败" });
      }
    );
  }

  editMessagePrompt(msg: Message) {
    promptAction.showDialog({
      title: "编辑消息（发送后2分钟内）",
      message: "请在聊天输入框中修改后发送；原消息会保留编辑记录。",
      buttons: [{ text: "取消", color: "#666666" }, { text: "载入输入框", color: this.themeColor }]
    }).then((result: promptAction.ShowDialogSuccessResponse) => {
      if (result.index === 1) {
        this.msgInput = msg.content;
        this.editingMessageId = msg.id || 0;
      }
    });
  }

  forwardMessageApi(msgId: number, target: Relation) {
    let payload: ForwardMsgPayload = { room_id: target.type === "group" ? target.id : 0 };
    if (target.type === "friend" && target.targetUser) {
      payload.receiver = target.targetUser;
    }
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/messages/${msgId}/forward`,
      {
        method: http.RequestMethod.POST,
        header: { 'Authorization': this.token, 'Content-Type': 'application/json' },
        extraData: JSON.stringify(payload)
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "消息已转发" });
        } else {
          promptAction.showToast({ message: "消息转发失败" });
        }
      }
    );
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

  getCardField(content: string, fieldIndex: number): string {
    if (!content || !content.startsWith("[user_card:") || !content.endsWith("]")) {
      return "";
    }
    let raw = content.substring(11, content.length - 1);
    let parts = raw.split(":");
    if (fieldIndex < parts.length) {
      if (fieldIndex === 0) {
        return parts[0];
      }
      try {
        return decodeURIComponent(parts[fieldIndex]);
      } catch (e) {
        return parts[fieldIndex];
      }
    }
    return "";
  }

  // Directly add a friend (bypass approval for user card)
  addFriendDirectly(targetUsername: string) {
    if (targetUsername === this.currentUsername) {
      promptAction.showToast({ message: "不能添加自己为好友" });
      return;
    }
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/friends/add`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          username: targetUsername
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
          promptAction.showToast({ message: "已成功添加好友！" });
          this.loadRelations();
        } else {
          promptAction.showToast({ message: "添加好友失败" });
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
    let editId = this.editingMessageId;
    this.editingMessageId = 0;
    let clientId = `${this.currentUsername}-${Date.now()}`;
    
    let postData: SendMsgPayload = {
      content: text,
      room_id: this.activeRoomId,
      client_id: clientId
    };
    if (this.activeTargetUser) {
      postData.receiver = this.activeTargetUser;
    }
    
    let httpRequest = http.createHttp();
    httpRequest.request(
      editId > 0 ? `${this.serverUrl}/api/messages/${editId}` : `${this.serverUrl}/api/messages`,
      {
        method: editId > 0 ? http.RequestMethod.PUT : http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify(editId > 0 ? { 'content': text } : postData)
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err) {
          this.loadHistory();
        } else {
          promptAction.showToast({ message: editId > 0 ? "编辑消息失败" : "发送消息失败" });
        }
      }
    );
  }

  showSendCardDialog() {
    this.cardModalVisible = true;
  }

  sendCardMessageDirectly(cardUser: string, cardNickname: string, cardAvatar: string) {
    let encodedNickname = encodeURIComponent(cardNickname);
    let encodedAvatar = encodeURIComponent(cardAvatar);
    let content = `[user_card:${cardUser}:${encodedNickname}:${encodedAvatar}]`;
    
    let postData: SendMsgPayload = {
      content: content,
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
        if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
          this.loadHistory();
        } else {
          promptAction.showToast({ message: "名片发送失败" });
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
        { text: "🔐 扫码登录测试", color: "#FF9500" },
        { text: "📷 扫描二维码", color: "#9C27B0" }
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
        } else if (data.index === 3) {
          this.startQrScan();
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

  // Safely get emojis of active category
  getActiveEmojis(): string[] {
    let cat = this.activeEmojiCategory;
    if (this.emojiCategories[cat]) {
      return this.emojiCategories[cat];
    }
    return [];
  }

  // Fetch user's favorite emojis list
  loadFavoriteEmojis() {
    if (!this.token) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/favorites/emojis`,
      {
        method: http.RequestMethod.GET,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let res = JSON.parse(data.result as string) as Record<string, string[]>;
            this.favoriteEmojis = res.data || [];
            this.emojiCategories["❤️ 收藏"] = this.favoriteEmojis;
          } catch(e) {
            // parse error
          }
        }
      }
    );
  }

  // Add emoji to favorites
  addFavoriteEmoji(emoji: string) {
    if (!this.token) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/favorites/emojis`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          emoji: emoji
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
          promptAction.showToast({ message: "已添加至收藏" });
          this.loadFavoriteEmojis();
        } else {
          promptAction.showToast({ message: "添加收藏失败" });
        }
      }
    );
  }

  // Delete emoji from favorites
  deleteFavoriteEmoji(emoji: string) {
    if (!this.token) return;
    let httpRequest = http.createHttp();
    httpRequest.request(
      `${this.serverUrl}/api/favorites/emojis`,
      {
        method: http.RequestMethod.DELETE,
        header: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        },
        extraData: JSON.stringify({
          emoji: emoji
        })
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          promptAction.showToast({ message: "已从收藏中移除" });
          this.loadFavoriteEmojis();
        } else {
          promptAction.showToast({ message: "移除收藏失败" });
        }
      }
    );
  }

  // Send raw content directly
  sendRawMessage(text: string) {
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
          this.loadHistory();
        } else {
          promptAction.showToast({ message: "发送消息失败" });
        }
      }
    );
  }

  // Combine and upload file using multipart form data
  uploadFileAndSend(uri: string, filename: string, isImage: boolean) {
    try {
      let file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      let stat = fs.statSync(file.fd);
      let buffer = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buffer);
      fs.closeSync(file);
      
      let boundary = "----WebKitFormBoundaryHarmonyOS" + Date.now().toString(16);
      let headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${isImage ? 'image/png' : 'application/octet-stream'}\r\n\r\n`;
      let footerStr = `\r\n--${boundary}--\r\n`;
      
      let headerBuf = this.stringToArrayBuffer(headerStr);
      let footerBuf = this.stringToArrayBuffer(footerStr);
      
      let combined = new Uint8Array(headerBuf.byteLength + buffer.byteLength + footerBuf.byteLength);
      combined.set(new Uint8Array(headerBuf), 0);
      combined.set(new Uint8Array(buffer), headerBuf.byteLength);
      combined.set(new Uint8Array(footerBuf), headerBuf.byteLength + buffer.byteLength);
      
      let httpRequest = http.createHttp();
      httpRequest.request(
        `${this.serverUrl}/api/upload`,
        {
          method: http.RequestMethod.POST,
          header: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Authorization': this.token
          },
          extraData: combined.buffer
        },
        (err: BusinessError, data: http.HttpResponse) => {
          if (!err && (data.responseCode === 200 || data.responseCode === 201)) {
            try {
              let res = JSON.parse(data.result as string) as Record<string, string>;
              let fileUrl = res.url || "";
              if (fileUrl) {
                if (isImage) {
                  this.sendRawMessage(`[img:${fileUrl}]`);
                } else {
                  this.sendRawMessage(`[file:${fileUrl}|${filename}]`);
                }
              } else {
                promptAction.showToast({ message: "文件上传失败：返回的链接为空" });
              }
            } catch(e) {
              promptAction.showToast({ message: "解析上传响应失败" });
            }
          } else {
            promptAction.showToast({ message: `文件上传失败 code=${data ? data.responseCode : -1}` });
          }
        }
      );
    } catch(e) {
      promptAction.showToast({ message: "打开/读取 file 失败" });
    }
  }

  stringToArrayBuffer(str: string): ArrayBuffer {
    let buf = new ArrayBuffer(str.length);
    let bufView = new Uint8Array(buf);
    for (let i = 0; i < str.length; i++) {
      bufView[i] = str.charCodeAt(i);
    }
    return buf;
  }

  // Open photo picker to select image
  selectImageForChat() {
    try {
      let photoPicker = new picker.PhotoViewPicker();
      photoPicker.select({
        MIMEType: picker.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 1
      }).then((result: picker.PhotoSelectResult) => {
        if (result && result.photoUris && result.photoUris.length > 0) {
          let uri = result.photoUris[0];
          let filename = "image_" + Date.now().toString() + ".png";
          this.uploadFileAndSend(uri, filename, true);
        }
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "选择图片异常" });
      });
    } catch(e) {
      promptAction.showToast({ message: "打开相册失败" });
    }
  }

  // Capture photo via camera picker
  takePhotoForChat() {
    try {
      let mContext = getContext(this) as common.UIAbilityContext;
      let pickerProfile: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
      };
      cameraPicker.pick(mContext, [cameraPicker.PickerMediaType.PHOTO], pickerProfile).then((pickerResult: cameraPicker.PickerResult) => {
        if (pickerResult && pickerResult.resultUri) {
          let uri = pickerResult.resultUri;
          let filename = "photo_" + Date.now().toString() + ".png";
          this.uploadFileAndSend(uri, filename, true);
        }
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "拍照异常" });
      });
    } catch(e) {
      promptAction.showToast({ message: "打开相机失败" });
    }
  }

  // Select document picker to select file
  selectFileForChat() {
    try {
      let documentPicker = new picker.DocumentViewPicker();
      documentPicker.select({
        maxSelectNumber: 1
      }).then((result: string[]) => {
        if (result && result.length > 0) {
          let uri = result[0];
          let filename = "file_" + Date.now().toString() + ".bin";
          this.uploadFileAndSend(uri, filename, false);
        }
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "选择文件异常" });
      });
    } catch(e) {
      promptAction.showToast({ message: "打开文件管理器失败" });
    }
  }

  // Trigger attachment options menu
  showAttachmentMenu() {
    promptAction.showActionMenu({
      title: "发送附件",
      buttons: [
        { text: "🖼️ 发送图片 (相册)", color: this.themeColor },
        { text: "📷 现场拍照并发送", color: "#FF9500" },
        { text: "📁 发送文档/文件", color: "#4CAF50" },
        { text: "📇 发送名片", color: "#9C27B0" }
      ]
    }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
      if (!err) {
        if (data.index === 0) {
          this.selectImageForChat();
        } else if (data.index === 1) {
          this.takePhotoForChat();
        } else if (data.index === 2) {
          this.selectFileForChat();
        } else if (data.index === 3) {
          this.showSendCardDialog();
        }
      }
    });
  }

  // Capture photo for avatar replacement
  takePhotoForAvatar() {
    try {
      let mContext = getContext(this) as common.UIAbilityContext;
      let pickerProfile: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
      };
      cameraPicker.pick(mContext, [cameraPicker.PickerMediaType.PHOTO], pickerProfile).then((pickerResult: cameraPicker.PickerResult) => {
        if (pickerResult && pickerResult.resultUri) {
          let uri = pickerResult.resultUri;
          let file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
          let stat = fs.statSync(file.fd);
          let buffer = new ArrayBuffer(stat.size);
          fs.readSync(file.fd, buffer);
          fs.closeSync(file);
          
          let base64Str = this.arrayBufferToBase64(buffer);
          this.newAvatarVal = `data:image/png;base64,${base64Str}`;
          promptAction.showToast({ message: "拍摄头像成功" });
        }
      }).catch((e: BusinessError) => {
        promptAction.showToast({ message: "拍摄头像异常" });
      });
    } catch(e) {
      promptAction.showToast({ message: "打开相机失败" });
    }
  }

  // Start system camera QR scanning with fallback to camera picker + JS decoder
  startQrScan() {
    try {
      let options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.ALL],
        enableMultiMode: true,
        enableAlbum: true
      };
      let mContext = getContext(this) as common.UIAbilityContext;
      scanBarcode.startScanForResult(mContext, options)
        .then((result: scanBarcode.ScanResult) => {
          if (result && result.originalValue) {
            this.handleQrCodeResult(result.originalValue);
          } else {
            promptAction.showToast({ message: "未识别到二维码" });
          }
        })
        .catch((error: BusinessError) => {
          console.warn(`[Scan] startScanForResult failed, falling back to cameraPicker: ${JSON.stringify(error)}`);
          this.startCameraPickerScan();
        });
    } catch (e) {
      console.warn(`[Scan] startScanForResult exception, falling back to cameraPicker: ${JSON.stringify(e)}`);
      this.startCameraPickerScan();
    }
  }

  // Open camera picker to capture a photo, then decode QR code using zxing
  async startCameraPickerScan() {
    try {
      let mContext = getContext(this) as common.UIAbilityContext;
      let pickerProfile: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
      };
      let pickerResult: cameraPicker.PickerResult = await cameraPicker.pick(
        mContext,
        [cameraPicker.PickerMediaType.PHOTO],
        pickerProfile
      );

      if (pickerResult && pickerResult.resultUri) {
        promptAction.showToast({ message: "正在解析图片二维码..." });
        try {
          let qrCodeText = await this.decodeQrCodeFromUri(pickerResult.resultUri);
          if (qrCodeText) {
            this.handleQrCodeResult(qrCodeText);
          } else {
            promptAction.showToast({ message: "未识别到二维码，请手动输入" });
            this.qrScanModalVisible = true;
          }
        } catch (decodeErr) {
          console.error(`[Scan] QR decode error: ${JSON.stringify(decodeErr)}`);
          promptAction.showToast({ message: "解析失败或未识别到二维码，请手动输入" });
          this.qrScanModalVisible = true;
        }
      } else {
        // Cancelled or no image taken
        this.qrScanModalVisible = true;
      }
    } catch (e) {
      console.error(`[Scan] cameraPicker error: ${JSON.stringify(e)}`);
      this.qrScanModalVisible = true;
    }
  }

  // Decode QR code from image URI using @ohos/zxing pure JS decoder
  async decodeQrCodeFromUri(uri: string): Promise<string> {
    let file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    let imageSource = image.createImageSource(file.fd);
    let decodingOptions: image.DecodingOptions = {
      editable: true,
      desiredPixelFormat: 3, // RGBA_8888
    };
    let pixelMap = await imageSource.createPixelMap(decodingOptions);
    fs.closeSync(file.fd);

    let width = pixelMap.getImageInfoSync().size.width;
    let height = pixelMap.getImageInfoSync().size.height;
    let num = pixelMap.getPixelBytesNumber();
    let arrayBuffer = new ArrayBuffer(num);
    await pixelMap.readPixelsToBuffer(arrayBuffer);
    pixelMap.release();
    imageSource.release();

    let int32Array = new Int32Array(arrayBuffer);
    let luminanceSource = new RGBLuminanceSource(int32Array, width, height);
    let binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
    let reader = new MultiFormatReader();
    let hints: Map<DecodeHintType, Array<BarcodeFormat>> = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    reader.setHints(hints);

    let decodeResult = reader.decode(binaryBitmap);
    return decodeResult.getText();
  }

  // Handle scanned QR Code results
  handleQrCodeResult(val: string) {
    let text = val.trim();
    if (text.startsWith("openboard:add_friend:")) {
      let username = text.replace("openboard:add_friend:", "");
      if (username.length > 0) {
        promptAction.showDialog({
          title: "添加好友确认",
          message: `确定要添加扫码用户 @${username} 为好友吗？`,
          buttons: [
            { text: "取消", color: "#808080" },
            { text: "发送请求", color: this.themeColor }
          ]
        }, (err: BusinessError, data: promptAction.ShowDialogSuccessResponse) => {
          if (!err && data.index === 1) {
            this.sendRequest(username);
          }
        });
      } else {
        promptAction.showToast({ message: "无效的加好友链接" });
      }
    } else if (text.startsWith("openboard:login:")) {
      let token = text.replace("openboard:login:", "");
      this.qrCodeInput = token;
      this.qrLoginModalVisible = true;
    } else {
      promptAction.showToast({ message: `识别内容: ${text}` });
    }
  }

  // Filter and sort relations
  getFilteredSortedRelations(): Relation[] {
    let query = this.localSearchQuery.trim().toLowerCase();
    let filtered = this.relations;
    if (query.length > 0) {
      filtered = this.relations.filter((r: Relation) => {
        let nameMatch = r.name && r.name.toLowerCase().indexOf(query) !== -1;
        let userMatch = r.targetUser && r.targetUser.toLowerCase().indexOf(query) !== -1;
        return nameMatch || userMatch;
      });
    }
    let pinnedList: Relation[] = [];
    let unpinnedList: Relation[] = [];
    
    for (let i = 0; i < filtered.length; i++) {
      let r = filtered[i];
      let key = r.type === "group" ? `group:${r.id}` : `friend:${r.targetUser}`;
      if (this.pinnedChats.indexOf(key) !== -1) {
        pinnedList.push(r);
      } else {
        unpinnedList.push(r);
      }
    }
    return pinnedList.concat(unpinnedList);
  }

  // Filter contacts
  getFilteredContacts(): Relation[] {
    let query = this.localSearchQuery.trim().toLowerCase();
    let friends = this.relations.filter(r => r.type === "friend");
    if (query.length > 0) {
      return friends.filter((r: Relation) => {
        let nameMatch = r.name && r.name.toLowerCase().indexOf(query) !== -1;
        let userMatch = r.targetUser && r.targetUser.toLowerCase().indexOf(query) !== -1;
        return nameMatch || userMatch;
      });
    }
    return friends;
  }

  // Filter groups
  getFilteredGroups(): Relation[] {
    let query = this.localSearchQuery.trim().toLowerCase();
    let groups = this.relations.filter(r => r.type === "group");
    if (query.length > 0) {
      return groups.filter((r: Relation) => {
        return r.name && r.name.toLowerCase().indexOf(query) !== -1;
      });
    }
    return groups;
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
            this.loadFavoriteEmojis();
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
    if (!this.usernameInput || !this.passwordInput) {
      this.loginStatusMsg = "请填满用户名和密码";
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
          nickname: this.nicknameInput || null
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
              TextInput({ text: this.nicknameInput, placeholder: "昵称 (选填)" })
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
              
              Row({ space: 10 }) {
                Text("📷 扫码")
                  .fontSize(13)
                  .fontColor(Color.White)
                  .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                  .border({ width: 1, color: Color.White, radius: 4 })
                  .onClick(() => {
                    this.startQrScan();
                  })

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
                Column() {
                  TextInput({ text: this.localSearchQuery, placeholder: "🔍 搜索最近会话或好友..." })
                    .width("96%")
                    .height(40)
                    .margin(8)
                    .fontColor(Color.Black)
                    .placeholderColor(Color.Gray)
                    .onChange((val: string) => this.localSearchQuery = val)

                  List() {
                    // Public Lobby Shortcut
                    if ("公共大厅".indexOf(this.localSearchQuery.trim().toLowerCase()) !== -1 || this.localSearchQuery.trim() === "") {
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
                    }

                    ForEach(this.getFilteredSortedRelations(), (item: Relation) => {
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
                  .layoutWeight(1)
                }
                .width("100%")
                .height("100%")
              }.tabBar(this.TabBuilder("聊天", 0, "💬"))

              // Tab 1: 设置 (Settings)
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

                    // Account Devices & Security option
                    Row() {
                      Text("📱 登录设备与账号安全")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .layoutWeight(1)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    .onClick(() => {
                      this.fetchDevicesApi();
                    })

                    // Mini Game option
                    Row() {
                      Text("🎮 休闲小游戏")
                        .fontSize(15)
                        .fontColor(Color.Black)
                        .layoutWeight(1)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)
                    .onClick(() => {
                      this.gameCenterVisible = true;
                    })

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
                    // QR Code Card for adding friends
                    Column({ space: 10 }) {
                      Text("📷 我的二维码名片 (扫码加好友)")
                        .fontSize(15)
                        .fontWeight(FontWeight.Bold)
                        .fontColor(Color.Black)
                        .width("100%")
                      
                      Row() {
                        Image(`https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent("openboard:add_friend:" + this.currentUsername)}`)
                          .width(180)
                          .height(180)
                          .objectFit(ImageFit.Contain)
                          .onClick(() => {
                            this.previewImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent("openboard:add_friend:" + this.currentUsername)}`;
                          })
                      }
                      .width("100%")
                      .justifyContent(FlexAlign.Center)
                      
                      Text("点击二维码可放大预览")
                        .fontSize(12)
                        .fontColor(Color.Gray)
                    }
                    .width("100%")
                    .padding(16)
                    .backgroundColor(Color.White)
                    .borderRadius(8)

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
              }.tabBar(this.TabBuilder("设置", 1, "⚙️"))
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

            // Chat history search input
            Row() {
              TextInput({ text: this.chatSearchQuery, placeholder: "🔍 搜索聊天记录..." })
                .layoutWeight(1)
                .height(36)
                .fontColor(Color.Black)
                .placeholderColor(Color.Gray)
                .onChange((val: string) => {
                  this.chatSearchQuery = val;
                })
              if (this.chatSearchQuery.length > 0) {
                Button("清除")
                  .height(36)
                  .backgroundColor(Color.Transparent)
                  .fontColor(Color.Gray)
                  .fontSize(13)
                  .onClick(() => {
                    this.chatSearchQuery = "";
                  })
              }
            }
            .width("96%")
            .margin({ top: 6, bottom: 6 })
            .alignItems(VerticalAlign.Center)

            // Chat Messages Stream
            List({ scroller: this.scroller }) {
              ForEach(this.getFilteredMessages(), (msg: Message) => {
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
                        Text(`${msg.nickname || msg.name || "用户"} (@${msg.name || "unknown"})`)
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
                          } else if (msg.content && msg.content.startsWith("[img:") && msg.content.endsWith("]")) {
                            Image(this.getMessageImageUrl(msg.content, true))
                              .width(180)
                              .height(180)
                              .objectFit(ImageFit.Contain)
                              .borderRadius(6)
                              .onClick(() => {
                                this.previewImageUrl = this.getMessageImageUrl(msg.content, false);
                              })
                          } else if (msg.content && msg.content.startsWith("[file:") && msg.content.endsWith("]")) {
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
                          } else if (msg.content && msg.content.startsWith("[user_card:") && msg.content.endsWith("]")) {
                            Column() {
                              Row() {
                                if (this.getCardField(msg.content, 2) && this.getCardField(msg.content, 2).trim().length > 0) {
                                  Image(this.getCardField(msg.content, 2).startsWith("data:image") ? this.getCardField(msg.content, 2) : (this.getCardField(msg.content, 2).startsWith("http") ? this.getCardField(msg.content, 2) : `${this.serverUrl}${this.getCardField(msg.content, 2).startsWith('/') ? '' : '/'}${this.getCardField(msg.content, 2)}`))
                                    .width(36)
                                    .height(36)
                                    .borderRadius(18)
                                    .objectFit(ImageFit.Cover)
                                    .margin({ right: 8 })
                                } else {
                                  Text((this.getCardField(msg.content, 1) || this.getCardField(msg.content, 0) || '?').substring(0, 1).toUpperCase())
                                    .width(36)
                                    .height(36)
                                    .borderRadius(18)
                                    .textAlign(TextAlign.Center)
                                    .fontSize(14)
                                    .fontColor(Color.White)
                                    .backgroundColor(this.getAvatarBgColor(this.getCardField(msg.content, 0)))
                                    .margin({ right: 8 })
                                }
                                Column() {
                                  Text(this.getCardField(msg.content, 1) || this.getCardField(msg.content, 0))
                                    .fontSize(14)
                                    .fontWeight(FontWeight.Bold)
                                    .fontColor(Color.Black)
                                  Text("@" + this.getCardField(msg.content, 0))
                                    .fontSize(11)
                                    .fontColor(Color.Gray)
                                    .margin({ top: 2 })
                                }
                                .alignItems(HorizontalAlign.Start)
                              }
                              .width('100%')
                              .alignItems(VerticalAlign.Center)

                              Divider()
                                .strokeWidth(0.5)
                                .color("#CCCCCC")
                                .margin({ top: 8, bottom: 8 })

                              Button(this.getCardField(msg.content, 0) === this.currentUsername ? "我的名片" : "直接加好友")
                                .fontSize(12)
                                .fontColor(Color.White)
                                .height(28)
                                .width('100%')
                                .backgroundColor(this.getCardField(msg.content, 0) === this.currentUsername ? Color.Gray : this.themeColor)
                                .enabled(this.getCardField(msg.content, 0) !== this.currentUsername)
                                .onClick(() => {
                                  let cardUser = this.getCardField(msg.content, 0);
                                  this.addFriendDirectly(cardUser);
                                })
                            }
                            .width(200)
                            .padding(8)
                            .backgroundColor(Color.White)
                            .borderRadius(8)
                            .borderWidth(1)
                            .borderColor("#E0E0E0")
                          } else {
                            Text(msg.content)
                              .fontSize(14)
                              .fontColor(msg.name === this.currentUsername ? Color.White : Color.Black)
                          }
                        }
                        .padding((msg.content && (msg.content.startsWith("[img:") || msg.content.startsWith("[user_card:"))) ? 0 : 10)
                        .backgroundColor(msg.content === "[system_recalled]" ? "#F0F0F0" : ((msg.content && (msg.content.startsWith("[img:") || msg.content.startsWith("[user_card:"))) ? Color.Transparent : (msg.name === this.currentUsername ? this.themeColor : "#E0E0E0")))
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
                      if (msg.edited === true || msg.edited_at || msg.name === this.currentUsername) {
                        Text(`${msg.edited === true || msg.edited_at ? "已编辑" : ""}${msg.name === this.currentUsername ? ((msg.edited === true || msg.edited_at ? " · " : "") + ((msg.read_count || 0) > 0 ? `${msg.read_count}人已读` : "未读")) : ""}`)
                          .fontSize(10)
                          .fontColor(Color.Gray)
                          .margin({ top: 2 })
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
              }, (msg: Message) => {
                let contentSnippet = msg.content ? msg.content.substring(0, 10) : "";
                return (msg.id ? msg.id.toString() : "") + "_" + msg.time + "_" + (msg.name || "unknown") + "_" + contentSnippet;
              })
            }
            .width("100%")
            .layoutWeight(1)
            .backgroundColor("#FAFAFA")
            .onReachStart(() => {
              if (this.hasMoreHistory) this.loadHistory(true);
            })

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
              Button("＋")
                .width(42)
                .height(42)
                .backgroundColor("#F5F7FA")
                .fontColor(Color.Black)
                .fontSize(20)
                .margin({ right: 8 })
                .onClick(() => {
                  this.showAttachmentMenu();
                })

              TextInput({ text: this.msgInput, placeholder: "说点什么吧..." })
                .layoutWeight(1)
                .height(42)
                .fontColor(Color.Black)
                .placeholderColor(Color.Gray)
                .onChange((val: string) => {
                  this.msgInput = val;
                  this.triggerTyping();
                })
              
              Button("😃")
                .width(42)
                .height(42)
                .backgroundColor("#F5F7FA")
                .fontColor(Color.Black)
                .margin({ left: 8 })
                .onClick(() => {
                  this.isEmojiPickerVisible = !this.isEmojiPickerVisible;
                })

              Button("发送")
                .width(70)
                .height(42)
                .margin({ left: 8 })
                .backgroundColor(this.themeColor)
                .onClick(() => {
                  this.sendMessage();
                  this.isEmojiPickerVisible = false;
                })
            }.width("100%").padding(10).backgroundColor("#FFFFFF").border({ width: { top: 1 }, color: "#E0E0E0" })

            // Complete Emoji Picker & Favorites Keyboard Panel
            if (this.isEmojiPickerVisible) {
              Column() {
                // Category Tab Row
                Row() {
                  List() {
                    ForEach(this.emojiCategoryNames, (catName: string) => {
                      ListItem() {
                        Text(catName)
                          .fontSize(14)
                          .fontWeight(this.activeEmojiCategory === catName ? FontWeight.Bold : FontWeight.Normal)
                          .fontColor(this.activeEmojiCategory === catName ? this.themeColor : Color.Black)
                          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
                          .border({ width: { bottom: this.activeEmojiCategory === catName ? 2 : 0 }, color: this.themeColor })
                          .onClick(() => {
                            this.activeEmojiCategory = catName;
                          })
                      }
                    })
                  }
                  .listDirection(Axis.Horizontal)
                  .width("100%")
                  .height(40)
                }.width("100%").backgroundColor("#F5F7FA").border({ width: { bottom: 1 }, color: "#E8E8E8" })

                // Emoji Grid Area
                Grid() {
                  ForEach(this.getActiveEmojis(), (emoji: string) => {
                    GridItem() {
                      Column() {
                        if (emoji.startsWith("[img:") && emoji.endsWith("]")) {
                          Image(emoji.substring(5, emoji.length - 1).startsWith("http") ? 
                            emoji.substring(5, emoji.length - 1) : 
                            `${this.serverUrl}${emoji.substring(5, emoji.length - 1)}`
                          )
                            .width(44)
                            .height(44)
                            .objectFit(ImageFit.Contain)
                            .borderRadius(4)
                        } else {
                          Text(emoji)
                            .fontSize(28)
                        }
                      }
                      .width("100%")
                      .height(54)
                      .justifyContent(FlexAlign.Center)
                      .alignItems(HorizontalAlign.Center)
                      .onClick(() => {
                        if (this.activeEmojiCategory === "❤️ 收藏") {
                          if (emoji.startsWith("[img:") && emoji.endsWith("]")) {
                            // Direct send custom sticker!
                            this.sendRawMessage(emoji);
                          } else {
                            this.msgInput += emoji;
                          }
                        } else {
                          this.msgInput += emoji;
                        }
                        this.triggerTyping();
                      })
                      .gesture(
                        LongPressGesture({ repeat: false })
                          .onAction(() => {
                            if (this.activeEmojiCategory === "❤️ 收藏") {
                              promptAction.showDialog({
                                title: "移除收藏",
                                message: "确定要将此表情从收藏中移除吗？",
                                buttons: [
                                  { text: "取消", color: "#808080" },
                                  { text: "删除", color: "#FF3B30" }
                                ]
                              }, (err: BusinessError, data: promptAction.ShowDialogSuccessResponse) => {
                                if (!err && data.index === 1) {
                                  this.deleteFavoriteEmoji(emoji);
                                }
                              });
                            } else {
                              promptAction.showDialog({
                                title: "添加收藏",
                                message: "要将此表情添加到收藏吗？",
                                buttons: [
                                  { text: "取消", color: "#808080" },
                                  { text: "收藏", color: this.themeColor }
                                ]
                              }, (err: BusinessError, data: promptAction.ShowDialogSuccessResponse) => {
                                if (!err && data.index === 1) {
                                  this.addFavoriteEmoji(emoji);
                                }
                              });
                            }
                          })
                      )
                    }
                  })
                }
                .columnsTemplate("1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr")
                .columnsGap(4)
                .rowsGap(4)
                .padding(8)
                .layoutWeight(1)
                .backgroundColor("#FAFAFA")
              }.width("100%").height(260).backgroundColor("#FAFAFA")
            }
          }.width("100%").height("100%")

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
      // Only display FAB on lists tabs (activeTabIndex === 0) when in MAIN view
      if (this.activeTabIndex === 0 && this.screenState === "MAIN") {
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

      // --- OVERLAY MODAL: DEVICE MANAGEMENT ---
      if (this.devicesModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("📱 已登录设备与账号安全")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            Text("以下是您当前账号已登录的设备列表：")
              .fontSize(12)
              .fontColor(Color.Gray)

            List({ space: 8 }) {
              ForEach(this.activeDevicesList, (item: Record<string, string | boolean>) => {
                ListItem() {
                  Row() {
                    Column({ space: 4 }) {
                      Text(`${item['device_name'] || '未知设备'} ${item['is_current'] ? '(当前设备)' : ''}`)
                        .fontSize(14)
                        .fontWeight(FontWeight.Bold)
                        .fontColor(Color.Black)
                      Text(`上次活跃: ${item['last_login'] || ''}`)
                        .fontSize(11)
                        .fontColor(Color.Gray)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    if (!item['is_current']) {
                      Button("下线")
                        .fontSize(12)
                        .height(30)
                        .backgroundColor(Color.Red)
                        .onClick(() => {
                          this.logoutDeviceApi(item['device_id'] as string);
                        })
                    }
                  }
                  .width("100%")
                  .padding(10)
                  .backgroundColor("#F5F5F5")
                  .borderRadius(6)
                }
              })
            }
            .height(200)
            .width("100%")

            Row({ space: 10 }) {
              Button("关闭")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(Color.Gray)
                .onClick(() => {
                  this.devicesModalVisible = false;
                })
            }
          }
          .width("85%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(12)
        }
        .width("100%")
        .height("100%")
        .backgroundColor("#80000000")
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: MINI GAME CENTER ---
      if (this.gameCenterVisible) {
        Column() {
          Row() {
            Text("‹ 返回")
              .fontSize(16)
              .fontColor(Color.White)
              .onClick(() => {
                this.gameCenterVisible = false;
              })

            Text("🎮 休闲小游戏")
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.White)
              .layoutWeight(1)
              .textAlign(TextAlign.Center)

            Text("刷新")
              .fontSize(14)
              .fontColor(Color.White)
              .onClick(() => {
                this.webviewController.refresh();
              })
          }
          .width("100%")
          .height(50)
          .padding({ left: 16, right: 16 })
          .backgroundColor(this.themeColor)

          Web({ src: $rawfile('game/index.html'), controller: this.webviewController })
            .width("100%")
            .layoutWeight(1)
            .javaScriptAccess(true)
            .fileAccess(true)
            .domStorageAccess(true)
        }
        .width("100%")
        .height("100%")
        .backgroundColor(Color.White)
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
            
            Button("📷 拍照更换头像")
              .width("100%")
              .height(40)
              .backgroundColor(this.themeColor)
              .onClick(() => {
                this.takePhotoForAvatar();
              })

            Button("🖼️ 从手机图库选择图片")
              .width("100%")
              .height(40)
              .backgroundColor(this.themeColor)
              .margin({ top: 8 })
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
        }.width("100%").height("100%").backgroundColor("#80000000").justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
      }

      // --- OVERLAY MODAL: QR SCAN FALLBACK ---
      if (this.qrScanModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("📷 扫描/识别二维码")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            Text("请输入二维码包含的内容或链接：\n(如：openboard:add_friend:username)")
              .fontSize(13)
              .fontColor(Color.Gray)
              .width("100%")
            
            TextInput({ text: this.qrScanInputVal, placeholder: "二维码内容" })
              .width("100%")
              .height(45)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.qrScanInputVal = val)

            Row({ space: 12 }) {
              Button("取消")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(Color.Gray)
                .onClick(() => {
                  this.qrScanModalVisible = false;
                  this.qrScanInputVal = "";
                })

              Button("确定识别")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(this.themeColor)
                .onClick(() => {
                  let val = this.qrScanInputVal;
                  this.qrScanModalVisible = false;
                  this.qrScanInputVal = "";
                  this.handleQrCodeResult(val);
                })
            }
            .width("100%")
            .margin({ top: 10 })
          }
          .width("80%")
          .padding(20)
          .backgroundColor(Color.White)
          .borderRadius(10)
        }.width("100%").height("100%").backgroundColor("#80000000").justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
      }

      if (this.forwardModalVisible) {
        Column() {
          Column({ space: 12 }) {
            Text("↗️ 转发到")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            List() {
              ForEach(this.relations, (item: Relation) => {
                ListItem() {
                  Row() {
                    Text(item.type === "group" ? "👥" : "👤")
                      .fontSize(22)
                      .margin({ right: 10 })
                    Column() {
                      Text(item.name)
                        .fontSize(14)
                        .fontWeight(FontWeight.Bold)
                        .fontColor(Color.Black)
                      Text(item.type === "group" ? "群聊" : `@${item.targetUser || ''}`)
                        .fontSize(11)
                        .fontColor(Color.Gray)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)
                    Button("转发")
                      .fontSize(12)
                      .height(28)
                      .backgroundColor(this.themeColor)
                      .onClick(() => {
                        this.forwardModalVisible = false;
                        this.forwardMessageApi(this.forwardMessageId, item);
                      })
                  }
                  .width("100%")
                  .padding({ top: 8, bottom: 8 })
                  .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                }
              })
            }
            .width("100%")
            .height(300)
            Button("取消")
              .width("100%")
              .height(40)
              .backgroundColor(Color.Gray)
              .onClick(() => {
                this.forwardModalVisible = false;
              })
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

      // --- OVERLAY MODAL: SEND CARD SELECTOR ---
      if (this.cardModalVisible) {
        Column() {
          Column({ space: 15 }) {
            Text("📇 选择要发送的名片")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
              .margin({ bottom: 5 })

            List() {
              // Option 1: Own Card
              ListItem() {
                Row() {
                  if (this.currentUserAvatar && this.currentUserAvatar.trim().length > 0) {
                    Image(this.currentUserAvatar.startsWith("data:image") ? this.currentUserAvatar : (this.currentUserAvatar.startsWith("http") ? this.currentUserAvatar : `${this.serverUrl}${this.currentUserAvatar.startsWith('/') ? '' : '/'}${this.currentUserAvatar}`))
                      .width(36)
                      .height(36)
                      .borderRadius(18)
                      .objectFit(ImageFit.Cover)
                      .margin({ right: 10 })
                  } else {
                    Text((this.currentUserNickname || this.currentUsername || '?').substring(0, 1).toUpperCase())
                      .width(36)
                      .height(36)
                      .borderRadius(18)
                      .textAlign(TextAlign.Center)
                      .fontSize(14)
                      .fontColor(Color.White)
                      .backgroundColor(this.getAvatarBgColor(this.currentUsername))
                      .margin({ right: 10 })
                  }
                  Column() {
                    Text((this.currentUserNickname || this.currentUsername) + " (我)")
                      .fontSize(14)
                      .fontWeight(FontWeight.Bold)
                      .fontColor(Color.Black)
                    Text("@" + this.currentUsername)
                      .fontSize(11)
                      .fontColor(Color.Gray)
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  Button("选择")
                    .fontSize(12)
                    .height(28)
                    .backgroundColor(this.themeColor)
                    .onClick(() => {
                      this.cardModalVisible = false;
                      this.sendCardMessageDirectly(this.currentUsername, this.currentUserNickname || this.currentUsername, this.currentUserAvatar || "");
                    })
                }
                .width("100%")
                .padding({ top: 8, bottom: 8 })
                .border({ width: { bottom: 1 }, color: "#F0F0F0" })
              }

              // Option 2: Friends list
              ForEach(this.relations.filter(r => r.type === "friend" && r.targetUser !== "filehelper"), (item: Relation) => {
                ListItem() {
                  Row() {
                    if (item.avatar && item.avatar.trim().length > 0) {
                      Image(item.avatar.startsWith("data:image") ? item.avatar : (item.avatar.startsWith("http") ? item.avatar : `${this.serverUrl}${item.avatar.startsWith('/') ? '' : '/'}${item.avatar}`))
                        .width(36)
                        .height(36)
                        .borderRadius(18)
                        .objectFit(ImageFit.Cover)
                        .margin({ right: 10 })
                    } else {
                      Text((item.name || '?').substring(0, 1).toUpperCase())
                        .width(36)
                        .height(36)
                        .borderRadius(18)
                        .textAlign(TextAlign.Center)
                        .fontSize(14)
                        .fontColor(Color.White)
                        .backgroundColor(this.getAvatarBgColor(item.targetUser || ""))
                        .margin({ right: 10 })
                    }
                    Column() {
                      Text(item.name)
                        .fontSize(14)
                        .fontWeight(FontWeight.Bold)
                        .fontColor(Color.Black)
                      Text("@" + (item.targetUser || ""))
                        .fontSize(11)
                        .fontColor(Color.Gray)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    Button("选择")
                      .fontSize(12)
                      .height(28)
                      .backgroundColor(this.themeColor)
                      .onClick(() => {
                        this.cardModalVisible = false;
                        this.sendCardMessageDirectly(item.targetUser || "", item.name, item.avatar || "");
                      })
                  }
                  .width("100%")
                  .padding({ top: 8, bottom: 8 })
                  .border({ width: { bottom: 1 }, color: "#F0F0F0" })
                }
              })
            }
            .width("100%")
            .height(250)

            Button("取消")
              .width("100%")
              .height(40)
              .backgroundColor(Color.Gray)
              .onClick(() => {
                this.cardModalVisible = false;
              })
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

      if (this.screenState === "LOGIN" && !this.showServerSettings && !this.qrScanModalVisible) {
        Row() {
          Blank()
          Text("⋮")
            .fontSize(30)
            .fontColor(Color.Black)
            .fontWeight(FontWeight.Bold)
            .padding({ left: 20, right: 20, top: 15, bottom: 15 })
            .onClick(() => {
              promptAction.showActionMenu({
                title: "设置",
                buttons: [
                  { text: "⚙️ 设置服务器地址", color: this.themeColor }
                ]
              }, (err: BusinessError, data: promptAction.ActionMenuSuccessResponse) => {
                if (!err && data.index === 0) {
                  this.showServerSettings = true;
                }
              });
            })
        }
        .width("100%")
        .position({ x: 0, y: 0 })
      }

      if (this.showServerSettings) {
        Column() {
          Column({ space: 15 }) {
            Text("设置服务器地址")
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.Black)
            
            Text("请输入信语服务端地址 (例：http://ip:port)")
              .fontSize(13)
              .fontColor(Color.Gray)
              .width("100%")
            
            TextInput({ text: this.serverUrl, placeholder: "https://liuyan.luojunqi.xyz" })
              .width("100%")
              .height(45)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => {
                this.serverUrl = val;
              })

            Row({ space: 12 }) {
              Button("取消")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(Color.Gray)
                .onClick(() => {
                  this.showServerSettings = false;
                })

              Button("保存")
                .layoutWeight(1)
                .height(40)
                .backgroundColor(this.themeColor)
                .onClick(() => {
                  let sUrl = this.serverUrl.trim();
                  if (!sUrl) {
                    promptAction.showToast({ message: "服务器地址不能为空" });
                    return;
                  }
                  if (sUrl.startsWith("https://")) {
                    this.wsUrl = sUrl.replace("https://", "wss://");
                  } else {
                    this.wsUrl = sUrl.replace("http://", "ws://");
                  }
                  this.saveLocalSettings();
                  this.showServerSettings = false;
                  promptAction.showToast({ message: "设置已保存" });
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
