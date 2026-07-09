import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;
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
  bool _showEmojiPanel = false;
  String _selectedEmojiCategory = '😀';
  List<String> _favoriteEmojis = [];

  static const Map<String, List<String>> _categorizedEmojis = {
    '😀': ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'],
    '🐱': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦢', '🦉', '🦚', '🦜', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🦗', '🕷', '🕸', '🦂', '🐢', '🐍', '🦎', '🐙', '🦑', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🐐', '🦌', '🐕', '🐩', '🐈', '🐓', '🦃', '🦅', '🕊', '🐇', '🐁', '🐀', '🐿', '🦡', '🦔', '🐾', '🐉', '🐲', '🌵', '🎄', '🌲', '🌳', '🌴', '🌱', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃'],
    '🍏': ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🌽', '🥕', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🥞', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🥗', '🍿', '🧂', '🥫', '🍱', '🍘', '🍙', '🍚', '🍛', '🍜', '🍝', '🍠', '🍢', '🍣', '🍤', '🍥', '🦪', '🍡', '🥟', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '☕️', '🍵', '🥤', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉'],
    '⚽': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🥅', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛷', '⛸', '🥌', '🎿', '⛷', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '抓', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖', '🎫', '🎟', '🎪', '🤹', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎮', '🕹', '🎯', '🎲', '🎰', '🧩', '🎳'],
    '🚗': ['🚗', '🚙', '🚌', '🏎', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚜', '🛵', '🏍', '🛺', '🚲', '🛴', '🚏', '🛣', '⛽', '🚨', '🚥', '🚦', '🛑', '🚧', '⚓', '⛵', '🛶', '🚤', '🛳', '🚢', '✈️', '🛩', '🛫', '🛬', '🪂', '🚁', '🚟', '🚠', '🚡', '🛰', '🚀', '🛸', '🪐', '🌟', '⭐️', '✨', '⚡️', '☄️', '💥', '🔥', '🌪', '🌈', '☀️', '🌤', '⛅️', '🌥', '☁️', '🌦', '🌧', '⛈', '🌨', '❄️', '💨', '🌊', '💧', '💦', '🌫'],
    '💡': ['⌚️', '📱', '📲', '💻', '⌨️', '🖥', '🖱', '🎛', '🎚', '🎙', '📻', '📺', '📷', '📸', '📹', '📼', '🔍', '🔎', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒', '📝', '✉️', '📧', '📨', '📩', '📤', '📥', '📦', '🏷', '📁', '📂', '🗂', '📅', '📆', '🗒', '🗓', '🗃', '🗳', '🗄', '📋', '📌', '📍', '📎', '🖇', '📏', '📐', '✂️', '🖊', '🖋', '✒️', '🖌', '🖍', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝', '🔨', '⚒', '🛠', '⛏', '🔩', '⚙️', '🧱', '⛓', '🪓', '🔫', '🔮', '📿', '🏺'],
    '🏁': ['🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇨🇳', '🇭🇰', '🇲🇴', '🇹🇼', '🇺🇸', '🇬🇧', '🇯🇵', '🇰🇷', '🇫🇷', '🇩🇪', '🇷🇺', '🇨🇦', '🇦🇺', '🇮🇹', '🇪🇸', '🇮🇳', '🇸🇬', '🇲🇾', '🇹🇭', '🇻🇳', '🇵🇭', '🇮🇩', '🇧🇷', '🇿🇦']
  };

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _subscribeToEvents();
    _loadFavoriteEmojis();
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

      final serverUrl = ApiService().serverUrl;
      final token = ApiService().token;
      
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

  void _confirmDeleteFriend() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除好友'),
        content: Text('您确定要解除与 @${widget.targetUser} 的好友关系吗？此操作将无法撤销。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              final success = await ApiService().removeFriend(widget.targetUser!);
              if (success) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('已解除好友关系'), backgroundColor: Colors.green),
                );
                Navigator.pop(context); // Close the chat screen
              } else {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('删除好友失败'), backgroundColor: Colors.red),
                );
              }
            },
            child: const Text('确定', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
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
          if (widget.targetUser != null && widget.targetUser != 'filehelper')
            IconButton(
              icon: const Icon(Icons.person_remove, color: Colors.white),
              tooltip: '解除好友',
              onPressed: _confirmDeleteFriend,
            ),
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

                  // Emoji Toggle Button
                  IconButton(
                    icon: Icon(
                      _showEmojiPanel ? Icons.keyboard : Icons.sentiment_satisfied_alt,
                      color: Colors.blue.shade700,
                    ),
                    onPressed: () {
                      setState(() {
                        _showEmojiPanel = !_showEmojiPanel;
                        if (_showEmojiPanel) {
                          FocusScope.of(context).unfocus();
                        }
                      });
                    },
                  ),

                  // Main Text Input Area
                  Expanded(
                    child: TextField(
                      controller: _textController,
                      onChanged: _onTextChanged,
                      onTap: _onInputTap,
                      maxLines: 4,
                      minLines: 1,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _sendMessage(),
                      decoration: InputDecoration(
                        hintText: '消息...',
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

          // Emoji Panel
          if (_showEmojiPanel) _buildEmojiPanel(),
        ],
      ),
    );
  }

  void _loadFavoriteEmojis() async {
    final list = await ApiService().fetchFavoriteEmojis();
    setState(() {
      _favoriteEmojis = list;
    });
  }

  void _onInputTap() {
    if (_showEmojiPanel) {
      setState(() {
        _showEmojiPanel = false;
      });
    }
  }

  Widget _buildEmojiPanel() {
    return Container(
      height: 250,
      color: Colors.grey.shade50,
      child: Column(
        children: [
          // Emoji Category Headers
          Container(
            height: 40,
            color: Colors.grey.shade200,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                _buildCategoryBtn('❤️'),
                _buildCategoryBtn('😀'),
                _buildCategoryBtn('🐱'),
                _buildCategoryBtn('🍏'),
                _buildCategoryBtn('⚽'),
                _buildCategoryBtn('🚗'),
                _buildCategoryBtn('💡'),
                _buildCategoryBtn('🏁'),
              ],
            ),
          ),
          // Emoji Grid Area
          Expanded(
            child: _buildEmojiGrid(),
          ),
        ],
      ),
    );
  }

  Widget _buildCategoryBtn(String category) {
    final isSelected = _selectedEmojiCategory == category;
    return GestureDetector(
      onTap: () {
        setState(() {
          _selectedEmojiCategory = category;
        });
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        color: isSelected ? Colors.grey.shade50 : Colors.transparent,
        child: Text(
          category,
          style: const TextStyle(fontSize: 16),
        ),
      ),
    );
  }

  Widget _buildEmojiGrid() {
    List<String> emojis = [];
    if (_selectedEmojiCategory == '❤️') {
      emojis = _favoriteEmojis;
    } else {
      emojis = _categorizedEmojis[_selectedEmojiCategory] ?? [];
    }

    if (emojis.isEmpty && _selectedEmojiCategory == '❤️') {
      return const Center(
        child: Text(
          '长按下方任意表情即可添加收藏',
          style: TextStyle(color: Colors.grey, fontSize: 13),
        ),
      );
    }

    return GridView.builder(
      padding: const EdgeInsets.all(8),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 8,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
      ),
      itemCount: emojis.length + 1, // +1 for delete button
      itemBuilder: (context, index) {
        if (index == emojis.length) {
          // Delete Backspace Button
          return GestureDetector(
            onTap: () {
              final text = _textController.text;
              if (text.isNotEmpty) {
                _textController.text = text.characters.skipLast(1).toString();
              }
            },
            child: const Center(
              child: Icon(Icons.backspace_outlined, color: Colors.grey),
            ),
          );
        }

        final emoji = emojis[index];
        return GestureDetector(
          onTap: () {
            _textController.text += emoji;
          },
          onLongPress: () {
            _showEmojiActions(emoji);
          },
          child: Center(
            child: Text(
              emoji,
              style: const TextStyle(fontSize: 24),
            ),
          ),
        );
      },
    );
  }

  void _showEmojiActions(String emoji) {
    final isFav = _favoriteEmojis.contains(emoji);
    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(isFav ? Icons.favorite_border : Icons.favorite, color: isFav ? Colors.grey : Colors.red),
              title: Text(isFav ? '从收藏中删除' : '添加到我的收藏'),
              onTap: () async {
                Navigator.pop(context);
                bool success = false;
                if (isFav) {
                  success = await ApiService().removeFavoriteEmoji(emoji);
                  if (success) {
                    setState(() {
                      _favoriteEmojis.remove(emoji);
                    });
                  }
                } else {
                  success = await ApiService().addFavoriteEmoji(emoji);
                  if (success) {
                    setState(() {
                      if (!_favoriteEmojis.contains(emoji)) {
                        _favoriteEmojis.add(emoji);
                      }
                    });
                  }
                }
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(success ? (isFav ? '已删除收藏' : '已添加收藏') : '操作失败'),
                    duration: const Duration(seconds: 1),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
