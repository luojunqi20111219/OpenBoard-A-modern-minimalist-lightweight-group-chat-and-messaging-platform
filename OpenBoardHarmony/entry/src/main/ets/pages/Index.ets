import http from '@ohos.net.http';
import webSocket from '@ohos.net.webSocket';
import promptAction from '@ohos.promptAction';
import { BusinessError } from '@ohos.base';

interface Message {
  id?: number;
  name: string;
  nickname: string;
  content: string;
  time: string;
  room_id: number;
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

@Entry
@Component
struct Index {
  @State screenState: string = "LOGIN"; // LOGIN, MAIN, CHAT, ADD_FRIEND
  
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

  // Chat Data
  @State activeRoomId: number = 0;
  @State activeTargetUser: string = "";
  @State activeChatTitle: string = "公共大厅";
  @State messages: Message[] = [];
  @State msgInput: string = "";
  @State relations: Relation[] = [];
  
  // Search & Friend requests state
  @State searchQuery: string = "";
  @State searchResults: SearchedUserItem[] = [];
  @State incomingRequests: IncomingRequestItem[] = [];

  // WebSocket Instance
  private ws: webSocket.WebSocket | null = null;
  private scroller: Scroller = new Scroller();

  aboutToDisappear() {
    this.closeWebSocket();
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
                room_id: dataObj.room_id || 0
              };
              
              // Check if matches active screen
              if (msg.room_id === this.activeRoomId) {
                this.messages.push(msg);
                this.scrollToBottom();
              }
            } else if (dataObj.type === "friend_request") {
              promptAction.showToast({ message: `收到来自 ${dataObj.from_nickname || dataObj.from_user} 的好友申请` });
              this.loadFriendRequests();
            } else if (dataObj.type === "friend_accepted") {
              promptAction.showToast({ message: `您与 ${dataObj.from_nickname || dataObj.from_user} 已成为好友` });
              this.loadRelations();
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
            // API returns newest first, reverse to display historically
            this.messages = rawList.reverse();
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
            
            this.loginStatusMsg = "";
            this.screenState = "MAIN";
            
            // Init WebSocket & load rooms
            this.connectWebSocket();
            this.loadRelations();
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
                .backgroundColor("#1E88E5")
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
        // --- MAIN SESSION LIST SCREEN ---
        Column() {
          Row() {
            Text("💬 信语")
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.White)
              .layoutWeight(1)
            
            Text("➕ 添加好友")
              .fontSize(13)
              .fontColor(Color.White)
              .padding({ left: 10, right: 10, top: 6, bottom: 6 })
              .border({ width: 1, color: Color.White, radius: 4 })
              .onClick(() => {
                this.screenState = "ADD_FRIEND";
                this.loadFriendRequests();
              })
          }
          .width("100%")
          .height(56)
          .backgroundColor("#1565C0")
          .padding({ left: 16, right: 16 })
          .alignItems(VerticalAlign.Center)

          List() {
            // Lobby Shortcut
            ListItem() {
              Row() {
                Text("💬 公共大厅")
                  .fontSize(16)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(Color.Black)
                  .layoutWeight(1)
                
                Text("进入")
                  .fontSize(13)
                  .fontColor(Color.Gray)
              }
              .padding({ left: 16, right: 16, top: 16, bottom: 16 })
              .width("100%")
            }
            .onClick(() => {
              this.activeRoomId = 0;
              this.activeTargetUser = "";
              this.activeChatTitle = "公共大厅";
              this.loadHistory();
              this.screenState = "CHAT";
            })
            .border({ width: { bottom: 1 }, color: "#F0F0F0" })

            ForEach(this.relations, (item: Relation) => {
              ListItem() {
                Row() {
                  Text(item.type === "group" ? `👥 ${item.name}` : `👤 ${item.name}`)
                    .fontSize(16)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(Color.Black)
                    .layoutWeight(1)
                  
                  Text("进入")
                    .fontSize(13)
                    .fontColor(Color.Gray)
                }
                .padding({ left: 16, right: 16, top: 16, bottom: 16 })
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
                this.loadHistory();
                this.screenState = "CHAT";
              })
              .border({ width: { bottom: 1 }, color: "#F0F0F0" })
            })
          }
          .width("100%")
          .layoutWeight(1)
          .backgroundColor("#FFFFFF")
          
          // Logout button
          Button("退出登录")
            .width("90%")
            .height(45)
            .margin({ bottom: 20 })
            .backgroundColor(Color.Red)
            .onClick(() => {
              this.closeWebSocket();
              this.screenState = "LOGIN";
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
                .fontColor("#1E88E5")
                .fontWeight(FontWeight.Medium)
            }
            .padding({ left: 16, right: 16 })
            .onClick(() => {
              this.screenState = "MAIN";
            })
            
            Text(this.activeChatTitle)
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

          // Chat Messages Stream
          List({ scroller: this.scroller }) {
            ForEach(this.messages, (msg: Message) => {
              ListItem() {
                Column() {
                  Row() {
                    Text(`${msg.nickname} (@${msg.name})`)
                      .fontSize(11)
                      .fontColor(Color.Gray)
                  }
                  .margin({ bottom: 2 })

                  Row() {
                    Column() {
                      if (msg.content.startsWith("[img:") && msg.content.endsWith("]")) {
                        Text("🖼️ [图片附件]")
                          .fontSize(14)
                          .fontColor(Color.Blue)
                      } else if (msg.content.startsWith("[file:") && msg.content.endsWith("]")) {
                        Text("📁 [文件附件]")
                          .fontSize(14)
                          .fontColor(Color.Green)
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
                    .backgroundColor(msg.name === this.currentUsername ? "#1E88E5" : "#E0E0E0")
                    .borderRadius(8)
                  }
                }
                .alignItems(msg.name === this.currentUsername ? HorizontalAlign.End : HorizontalAlign.Start)
                .width("100%")
                .padding({ left: 16, right: 16, top: 6, bottom: 6 })
              }
            })
          }
          .width("100%")
          .layoutWeight(1)
          .backgroundColor("#FAFAFA")

          // Chat bottom input panel
          Row() {
            TextInput({ text: this.msgInput, placeholder: "快来聊两句吧..." })
              .layoutWeight(1)
              .height(42)
              .fontColor(Color.Black)
              .placeholderColor(Color.Gray)
              .onChange((val: string) => this.msgInput = val)
            
            Button("发送")
              .width(70)
              .height(42)
              .margin({ left: 10 })
              .backgroundColor("#1E88E5")
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
                .fontColor("#1E88E5")
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
                  .backgroundColor("#1E88E5")
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
      }
    }
    .width("100%")
    .height("100%")
  }
}