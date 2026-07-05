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
  name: string;
  nickname?: string;
  content: string;
  time?: string;
  room_id?: number;
}

interface SendMsgPayload {
  content: string;
  room_id: number;
  receiver?: string;
}

@Entry
@Component
struct Index {
  @State screenState: string = "LOGIN"; // LOGIN or MAIN
  
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
                name: dataObj.name,
                nickname: dataObj.nickname || dataObj.name,
                content: dataObj.content,
                time: dataObj.time || new Date().toISOString(),
                room_id: dataObj.room_id || 0
              };
              
              // Check if matches active screen
              if (msg.room_id === this.activeRoomId) {
                this.messages.push(msg);
                this.scrollToBottom();
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

  // Load groups & friends
  loadRelations() {
    let httpRequest = http.createHttp();
    // 1. Groups
    httpRequest.request(
      `${this.serverUrl}/api/groups`,
      {
        method: http.RequestMethod.GET,
        header: { 'Authorization': this.token }
      },
      (err: BusinessError, data: http.HttpResponse) => {
        if (!err && data.responseCode === 200) {
          try {
            let list = JSON.parse(data.result as string) as GroupItem[];
            let grps: Relation[] = list.map((g: GroupItem): Relation => {
              return { id: g.id, name: g.name, type: "group" };
            });
            
            // 2. Friends
            let friendRequest = http.createHttp();
            friendRequest.request(
              `${this.serverUrl}/api/friends`,
              {
                method: http.RequestMethod.GET,
                header: { 'Authorization': this.token }
              },
              (fErr: BusinessError, fData: http.HttpResponse) => {
                if (!fErr && fData.responseCode === 200) {
                  let fRes = JSON.parse(fData.result as string) as FriendsResponse;
                  let friendsRaw = fRes.data || [];
                  let friends: Relation[] = friendsRaw.map((f: FriendItem): Relation => {
                    return { id: 0, name: f.nickname || f.username, type: "friend", targetUser: f.username };
                  });
                  this.relations = grps.concat(friends);
                }
              }
            );
          } catch (e) {
            console.error("Error fetching relations");
          }
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

      } else {
        // --- MAIN CHAT PANEL ---
        Row() {
          // 1. Left Sidebar (Rooms & Contacts)
          Column() {
            Row() {
              Text("👥 会话列表")
                .fontSize(16)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.White)
            }
            .width("100%")
            .height(55)
            .backgroundColor("#1565C0")
            .justifyContent(FlexAlign.Center)

            List() {
              // Lobby Shortcut
              ListItem() {
                Text("💬 公共大厅")
                  .fontSize(14)
                  .fontColor(this.activeRoomId === 0 && !this.activeTargetUser ? "#1E88E5" : Color.Black)
                  .fontWeight(this.activeRoomId === 0 && !this.activeTargetUser ? FontWeight.Bold : FontWeight.Normal)
                  .padding({ left: 15, right: 15, top: 12, bottom: 12 })
                  .width("100%")
              }
              .onClick(() => {
                this.activeRoomId = 0;
                this.activeTargetUser = "";
                this.activeChatTitle = "公共大厅";
                this.loadHistory();
              })

              ForEach(this.relations, (item: Relation) => {
                ListItem() {
                  Text(item.type === "group" ? `👥 ${item.name}` : `👤 ${item.name}`)
                    .fontSize(14)
                    .fontColor((item.type === "group" && this.activeRoomId === item.id) || (item.type === "friend" && this.activeTargetUser === item.targetUser) ? "#1E88E5" : Color.Black)
                    .fontWeight((item.type === "group" && this.activeRoomId === item.id) || (item.type === "friend" && this.activeTargetUser === item.targetUser) ? FontWeight.Bold : FontWeight.Normal)
                    .padding({ left: 15, right: 15, top: 12, bottom: 12 })
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
                })
              })
            }
            .width("100%")
            .layoutWeight(1)
            
            // Logout button
            Button("退出登录")
              .width("90%")
              .height(35)
              .margin(10)
              .backgroundColor(Color.Red)
              .onClick(() => {
                this.closeWebSocket();
                this.screenState = "LOGIN";
              })
          }
          .width("30%")
          .height("100%")
          .backgroundColor("#FFFFFF")
          .border({ width: { right: 1 }, color: "#E0E0E0" })

          // 2. Right Chat Screen
          Column() {
            // Chat header
            Row() {
              Text(this.activeChatTitle)
                .fontSize(16)
                .fontWeight(FontWeight.Bold)
                .fontColor(Color.Black)
            }
            .width("100%")
            .height(55)
            .backgroundColor("#F5F7FA")
            .padding({ left: 15 })
            .border({ width: { bottom: 1 }, color: "#E0E0E0" })

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
                  .padding({ left: 10, right: 10, top: 5, bottom: 5 })
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
                .height(40)
                .fontColor(Color.Black)
                .placeholderColor(Color.Gray)
                .onChange((val: string) => this.msgInput = val)
              
              Button("发送")
                .width(70)
                .height(40)
                .margin({ left: 10 })
                .backgroundColor("#1E88E5")
                .onClick(() => this.sendMessage())
            }
            .width("100%")
            .padding(10)
            .backgroundColor("#FFFFFF")
            .border({ width: { top: 1 }, color: "#E0E0E0" })
          }
          .width("70%")
          .height("100%")
        }
        .width("100%")
        .height("100%")
      }
    }
    .width("100%")
    .height("100%")
  }
}