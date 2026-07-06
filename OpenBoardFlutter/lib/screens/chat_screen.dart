import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:file_picker/file_picker.dart';
import '../models/message.dart';
import '../services/api_service.dart';
import '../widgets/chat_bubble.dart';

class ChatScreen extends StatefulWidget {
  final int relationId;
  final String title;
  final String? targetUser;
  final bool isOnline;

  const ChatScreen({
    super.key,
    required this.relationId,
    required this.title,
    this.targetUser,
    this.isOnline = false,
  });

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final List<Message> _messages = [];
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _textController = TextEditingController();
  bool _isLoadingHistory = false;
  bool _isOtherTyping = false;
  Timer? _typingTimer;
  Timer? _sendTypingThrottle;

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _subscribeToEvents();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _textController.dispose();
    _typingTimer?.cancel();
    _sendTypingThrottle?.cancel();
    super.dispose();
  }

  void _subscribeToEvents() {
    // Re-bind events in ApiService to update this screen dynamically
    ApiService().connectWebSocket(
      onMessageReceived: (msg) {
        // Check if message belongs to this chat
        final isLobby = widget.relationId == 0 && widget.targetUser == null && msg.roomId == 0;
        final isGroup = widget.relationId > 0 && msg.roomId == widget.relationId;
        final isPrivate = widget.targetUser != null &&
            ((msg.name == widget.targetUser && msg.roomId == 0) ||
                (msg.name == ApiService().currentUsername && msg.roomId == 0));

        if (isLobby || isGroup || isPrivate) {
          if (mounted) {
            setState(() {
              // If it's a recalled message, replace or reload
              if (msg.content == '[system_recalled]') {
                final idx = _messages.indexWhere((m) => m.id == msg.id);
                if (idx != -1) {
                  _messages[idx] = msg;
                } else {
                  _messages.add(msg);
                }
              } else {
                _messages.add(msg);
              }
            });
            _scrollToBottom();
          }
        }
      },
      onTypingReceived: (user, isTyping) {
        if (user == widget.targetUser) {
          if (mounted) {
            setState(() {
              _isOtherTyping = isTyping;
            });
          }
          // Reset typing timer (typing turns off automatically after 3s)
          _typingTimer?.cancel();
          if (isTyping) {
            _typingTimer = Timer(const Duration(seconds: 3), () {
              if (mounted) {
                setState(() {
                  _isOtherTyping = false;
                });
              }
            });
          }
        }
      },
      onOnlineStatusReceived: (_) {},
    );
  }

  Future<void> _loadHistory() async {
    setState(() {
      _isLoadingHistory = true;
    });
    final history = await ApiService().fetchHistory(
      roomId: widget.relationId,
      targetUser: widget.targetUser,
    );
    if (mounted) {
      setState(() {
        _messages.clear();
        _messages.addAll(history);
        _isLoadingHistory = false;
      });
      _scrollToBottom();
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        try {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          );
        } catch (_) {}
      }
    });
  }

  void _onTextChanged(String text) {
    if (widget.targetUser == null) return; // No typing indicator for groups/lobby

    if (_sendTypingThrottle == null || !_sendTypingThrottle!.isActive) {
      ApiService().sendTypingStatus(true, targetUser: widget.targetUser);
      _sendTypingThrottle = Timer(const Duration(seconds: 3), () {});
    }
  }

  Future<void> _sendMessage() async {
    final text = _textController.text.trim();
    if (text.isEmpty) return;

    _textController.clear();
    ApiService().sendTypingStatus(false, targetUser: widget.targetUser);

    try {
      // In OpenBoard, posting message goes to the database and WS broadcasts it
      final payload = {
        'room_id': widget.relationId,
        'receiver': widget.targetUser,
        'content': text,
      };

      final response = await ApiService().uploadAttachment(
        // Wait, for standard text we can use a direct HTTP post or WS send.
        // Let's call the POST messages API using http!
        File(''), // Empty file represents text message
      );
      
      // Let's implement postMessage directly using http
      final serverUrl = ApiService().serverUrl;
      final token = ApiService().token;
      
      await ApiService().setServerUrl(serverUrl); // Check server is up
      final res = await http.post(
        Uri.parse('$serverUrl/api/messages'),
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode(payload),
      );

      if (res.statusCode == 200) {
        // Message sent successfully, WebSocket broadcast will push it to our view
      } else {
        final body = jsonDecode(res.body);
        _showError(body['detail'] ?? '消息发送失败');
      }
    } catch (e) {
      _showError('网络连接失败，消息未发送');
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.red.shade700),
    );
  }

  Future<void> _pickImage(ImageSource source) async {
    final picker = ImagePicker();
    final XFile? image = await picker.pickImage(source: source);
    if (image == null) return;

    _uploadAndSendFile(File(image.path), isImage: true);
  }

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles();
    if (result == null || result.files.single.path == null) return;

    _uploadAndSendFile(File(result.files.single.path!), isImage: false);
  }

  Future<void> _uploadAndSendFile(File file, {required bool isImage}) async {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Row(
        children: [
          CircularProgressIndicator(strokeWidth: 2),
          SizedBox(width: 12),
          Text('正在上传附件...'),
        ],
      )),
    );

    final fileUrl = await ApiService().uploadAttachment(file);
    if (fileUrl == null) {
      _showError('文件上传失败，请检查文件大小或网络。');
      return;
    }

    // Compose custom file/image message format
    String content = '';
    if (isImage) {
      content = '[img:$fileUrl]';
    } else {
      final filename = file.path.substring(file.path.lastIndexOf('/') + 1);
      content = '[file:$fileUrl|$filename]';
    }

    // Send the message payload
    final serverUrl = ApiService().serverUrl;
    final token = ApiService().token;
    await http.post(
      Uri.parse('$serverUrl/api/messages'),
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'room_id': widget.relationId,
        'receiver': widget.targetUser,
        'content': content,
      }),
    );
  }

  void _showMsgActions(Message msg) {
    final isMyMsg = msg.name == ApiService().currentUsername;

    showModalBottomSheet(
      context: context,
      builder: (context) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.copy),
                title: const Text('复制文本'),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: msg.content));
                  Navigator.pop(context);
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('已复制到剪贴板')),
                  );
                },
              ),
              if (isMyMsg && msg.id != null) ...[
                ListTile(
                  leading: const Icon(Icons.undo, color: Colors.red),
                  title: const Text('撤回消息'),
                  onTap: () async {
                    Navigator.pop(context);
                    final success = await ApiService().recallMessage(msg.id!);
                    if (!success) {
                      _showError('撤回失败（消息可能已超过 2 分钟）');
                    }
                  },
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.title,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16.0, color: Colors.white),
            ),
            if (widget.targetUser != null)
              Text(
                widget.isOnline ? '在线' : '离线',
                style: TextStyle(
                  fontSize: 11.0,
                  color: widget.isOnline ? Colors.greenAccent : Colors.white70,
                ),
              ),
          ],
        ),
        backgroundColor: Colors.blue.shade800,
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            onPressed: _loadHistory,
          ),
        ],
      ),
      body: Column(
        children: [
          // Loading history indicator
          if (_isLoadingHistory)
            const LinearProgressIndicator(minHeight: 2),

          // Message Stream
          Expanded(
            child: Container(
              color: Colors.grey.shade50,
              child: ListView.builder(
                controller: _scrollController,
                itemCount: _messages.length,
                itemBuilder: (context, index) {
                  final msg = _messages[index];
                  final isSelf = msg.name == ApiService().currentUsername;
                  return ChatBubble(
                    message: msg,
                    isSelf: isSelf,
                    isOnline: widget.targetUser != null && widget.isOnline,
                    onLongPress: () => _showMsgActions(msg),
                  );
                },
              ),
            ),
          ),

          // Typing Indicator Bar
          if (_isOtherTyping)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 4.0),
              color: Colors.grey.shade100,
              alignment: Alignment.centerLeft,
              child: Text(
                '对方正在输入...',
                style: TextStyle(fontSize: 12.0, color: Colors.grey.shade500, fontStyle: FontStyle.italic),
              ),
            ),

          // Bottom Input Bar
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.05),
                  blurRadius: 4.0,
                  offset: const Offset(0, -1),
                ),
              ],
            ),
            padding: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 8.0),
            child: SafeArea(
              child: Row(
                children: [
                  // Attachment action options
                  IconButton(
                    icon: Icon(Icons.add_circle_outline, color: Colors.blue.shade700),
                    onPressed: () {
                      showModalBottomSheet(
                        context: context,
                        builder: (context) => SafeArea(
                          child: Wrap(
                            children: [
                              ListTile(
                                leading: const Icon(Icons.camera_alt),
                                title: const Text('相机拍照'),
                                onTap: () {
                                  Navigator.pop(context);
                                  _pickImage(ImageSource.camera);
                                },
                              ),
                              ListTile(
                                leading: const Icon(Icons.photo),
                                title: const Text('选择照片'),
                                onTap: () {
                                  Navigator.pop(context);
                                  _pickImage(ImageSource.gallery);
                                },
                              ),
                              ListTile(
                                leading: const Icon(Icons.attach_file),
                                title: const Text('发送文件'),
                                onTap: () {
                                  Navigator.pop(context);
                                  _pickFile();
                                },
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),

                  // Main Text Input Area
                  Expanded(
                    child: TextField(
                      controller: _textController,
                      onChanged: _onTextChanged,
                      maxLines: 4,
                      minLines: 1,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _sendMessage(),
                      decoration: InputDecoration(
                        hintText: '发送新消息...',
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 10.0),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(20.0),
                        ),
                        filled: true,
                        fillColor: Colors.grey.shade50,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8.0),

                  // Send Action Button
                  GestureDetector(
                    onTap: _sendMessage,
                    child: CircleAvatar(
                      backgroundColor: Colors.blue.shade700,
                      child: const Icon(Icons.send, color: Colors.white, size: 18),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
