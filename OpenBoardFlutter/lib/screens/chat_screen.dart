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
import '../widgets/avatar_widget.dart';

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
  bool _hasMoreHistory = true;
  int? _oldestMessageId;
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
    _scrollController.addListener(_handleHistoryScroll);
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
                final pendingIndex = _messages.indexWhere(
                  (item) => msg.clientId != null && item.clientId == msg.clientId,
                );
                if (pendingIndex >= 0) _messages.removeAt(pendingIndex);
                if (!_messages.any((item) => item.id == msg.id)) _messages.add(msg);
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

  Future<void> _loadHistory({bool older = false}) async {
    if (_isLoadingHistory || (older && !_hasMoreHistory)) return;
    final oldExtent = _scrollController.hasClients ? _scrollController.position.maxScrollExtent : 0.0;
    setState(() {
      _isLoadingHistory = true;
    });
    final page = await ApiService().fetchHistoryPage(
      roomId: widget.relationId,
      targetUser: widget.targetUser,
      beforeId: older ? _oldestMessageId : null,
    );
    if (mounted) {
      setState(() {
        _hasMoreHistory = page.hasMore;
        _oldestMessageId = page.nextBeforeId ?? (page.messages.isNotEmpty ? page.messages.first.id : null);
        if (older) {
          _messages.insertAll(
            0,
            page.messages.where((incoming) => !_messages.any((message) => message.id == incoming.id)),
          );
        } else {
          _messages.clear();
          _messages.addAll(page.messages);
        }
        _isLoadingHistory = false;
      });
      if (older) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scrollController.hasClients) {
            _scrollController.jumpTo(_scrollController.position.maxScrollExtent - oldExtent);
          }
        });
      } else {
        _scrollToBottom();
      }
      final readable = _messages.where((message) => message.id != null && message.id! > 0);
      if (readable.isNotEmpty) {
        ApiService().markMessagesRead(
          readable.last.id!,
          roomId: widget.relationId,
          targetUser: widget.targetUser,
        );
      }
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
    final clientId = '${ApiService().currentUsername}-${DateTime.now().microsecondsSinceEpoch}';
    final pending = Message(
      id: -DateTime.now().millisecondsSinceEpoch,
      name: ApiService().currentUsername,
      nickname: ApiService().currentNickname,
      avatar: ApiService().currentAvatar,
      content: text,
      time: '发送中',
      roomId: widget.relationId,
      receiver: widget.targetUser,
      clientId: clientId,
      deliveryStatus: 'sending',
    );
    setState(() => _messages.add(pending));
    _scrollToBottom();

    try {
      // In OpenBoard, posting message goes to the database and WS broadcasts it
      final payload = {
        'room_id': widget.relationId,
        'receiver': widget.targetUser,
        'content': text,
        'client_id': clientId,
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
        final index = _messages.indexWhere((message) => message.clientId == clientId);
        if (index >= 0 && mounted) {
          setState(() => _messages[index] = _messages[index].copyWith(
            time: '发送失败，长按重试',
            deliveryStatus: 'failed',
          ));
        }
        final body = jsonDecode(res.body);
        _showError(body['detail'] ?? '消息发送失败');
      }
    } catch (e) {
      final index = _messages.indexWhere((message) => message.clientId == clientId);
      if (index >= 0 && mounted) {
        setState(() => _messages[index] = _messages[index].copyWith(
          time: '发送失败，长按重试',
          deliveryStatus: 'failed',
        ));
      }
      _showError('网络连接失败，消息未发送');
    }
  }

  Future<void> _sendCardDirect(String username, String nickname, String avatar) async {
    final encodedNickname = Uri.encodeComponent(nickname);
    final encodedAvatar = Uri.encodeComponent(avatar);
    final content = '[user_card:$username:$encodedNickname:$encodedAvatar]';
    
    try {
      final payload = {
        'room_id': widget.relationId,
        'receiver': widget.targetUser,
        'content': content,
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

      if (res.statusCode != 200) {
        final body = jsonDecode(res.body);
        _showError(body['detail'] ?? '名片发送失败');
      }
    } catch (e) {
      _showError('网络连接失败，名片未发送');
    }
  }

  void _showSendCardDialog() async {
    final allRelations = await ApiService().fetchRelations();
    final friends = allRelations.where((r) => r.type == 'friend' && r.targetUser != 'filehelper').toList();

    if (!mounted) return;

    showDialog(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('选择要发送的名片'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: friends.length + 1,
              itemBuilder: (context, index) {
                final isOwn = index == 0;
                final username = isOwn ? ApiService().currentUsername : friends[index - 1].targetUser ?? '';
                final nickname = isOwn ? (ApiService().currentNickname.isNotEmpty ? ApiService().currentNickname : ApiService().currentUsername) : friends[index - 1].name;
                final avatar = isOwn ? ApiService().currentAvatar : friends[index - 1].avatar ?? '';

                return ListTile(
                  leading: AvatarWidget(
                    name: username,
                    nickname: nickname,
                    avatarUrl: avatar,
                    size: 40.0,
                  ),
                  title: Text(isOwn ? '$nickname (我)' : nickname),
                  subtitle: Text('@$username'),
                  onTap: () {
                    Navigator.pop(context);
                    _sendCardDirect(username, nickname, avatar);
                  },
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
          ],
        );
      },
    );
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
              if (msg.id != null)
                ListTile(
                  leading: const Icon(Icons.forward),
                  title: const Text('转发消息'),
                  onTap: () {
                    Navigator.pop(context);
                    _showForwardDialog(msg);
                  },
                ),
              if (msg.id != null && msg.id! > 0)
                ListTile(
                  leading: const Icon(Icons.bookmark_add_outlined),
                  title: const Text('收藏消息'),
                  onTap: () async {
                    Navigator.pop(context);
                    final success = await ApiService().favoriteMessage(msg.id!);
                    if (!success && mounted) _showError('收藏失败');
                  },
                ),
              if (isMyMsg && msg.canEdit && msg.id != null)
                ListTile(
                  leading: const Icon(Icons.edit_outlined),
                  title: const Text('编辑消息'),
                  onTap: () {
                    Navigator.pop(context);
                    _showEditMessageDialog(msg);
                  },
                ),
              if (isMyMsg && msg.canRecall && msg.id != null) ...[
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

  Future<void> _showEditMessageDialog(Message msg) async {
    final controller = TextEditingController(text: msg.content);
    final content = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('编辑消息（发送后2分钟内）'),
        content: TextField(controller: controller, autofocus: true, maxLines: 5),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, controller.text.trim()), child: const Text('保存')),
        ],
      ),
    );
    controller.dispose();
    if (content == null || content.isEmpty || msg.id == null) return;
    final success = await ApiService().editMessage(msg.id!, content);
    if (!success || !mounted) {
      if (mounted) _showError('编辑失败（消息可能已超过2分钟）');
      return;
    }
    final index = _messages.indexWhere((message) => message.id == msg.id);
    if (index >= 0) {
      setState(() => _messages[index] = _messages[index].copyWith(content: content, edited: true));
    }
  }

  void _handleHistoryScroll() {
    if (_scrollController.hasClients &&
        _scrollController.position.pixels <= 40 &&
        _hasMoreHistory &&
        !_isLoadingHistory) {
      _loadHistory(older: true);
    }
  }

  Future<void> _showForwardDialog(Message msg) async {
    final relations = await ApiService().fetchRelations();
    if (!mounted || msg.id == null) return;
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('转发到'),
        content: SizedBox(
          width: double.maxFinite,
          child: ListView.builder(
            shrinkWrap: true,
            itemCount: relations.length,
            itemBuilder: (context, index) {
              final relation = relations[index];
              return ListTile(
                leading: Icon(relation.type == 'group' ? Icons.group : Icons.person),
                title: Text(relation.name),
                onTap: () async {
                  Navigator.pop(dialogContext);
                  final success = await ApiService().forwardMessage(
                    msg.id!,
                    roomId: relation.type == 'group' ? relation.id : 0,
                    receiver: relation.type == 'friend' ? relation.targetUser : null,
                  );
                  if (!success && mounted) _showError('转发失败');
                },
              );
            },
          ),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('取消'))],
      ),
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

  Future<void> _showMessageSearch() async {
    final controller = TextEditingController();
    final query = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('搜索聊天记录'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '关键词'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, controller.text.trim()), child: const Text('搜索')),
        ],
      ),
    );
    controller.dispose();
    if (query == null || query.isEmpty) return;
    final results = await ApiService().searchMessages(
      query,
      roomId: widget.relationId,
      targetUser: widget.targetUser,
    );
    if (!mounted) return;
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('搜索结果'),
        content: SizedBox(
          width: double.maxFinite,
          child: results.isEmpty
              ? const Text('没有找到消息')
              : ListView.builder(
                  shrinkWrap: true,
                  itemCount: results.length,
                  itemBuilder: (_, index) => ListTile(
                    title: Text(results[index].nickname.isEmpty ? results[index].name : results[index].nickname),
                    subtitle: Text(results[index].content, maxLines: 2, overflow: TextOverflow.ellipsis),
                  ),
                ),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('关闭'))],
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
          IconButton(
            icon: const Icon(Icons.search, color: Colors.white),
            tooltip: '搜索聊天记录',
            onPressed: _showMessageSearch,
          ),
          if (widget.targetUser != null && widget.targetUser != 'filehelper')
            IconButton(
              icon: const Icon(Icons.person_remove, color: Colors.white),
              tooltip: '解除好友',
              onPressed: _confirmDeleteFriend,
            ),
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            onPressed: () => _loadHistory(),
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
                              ListTile(
                                leading: const Icon(Icons.contact_mail),
                                title: const Text('发送名片'),
                                onTap: () {
                                  Navigator.pop(context);
                                  _showSendCardDialog();
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
