import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../models/relation.dart';
import '../services/api_service.dart';
import 'chat_screen.dart';
import 'login_screen.dart';
import 'scan_screen.dart';
import '../widgets/avatar_widget.dart';

class MainScreen extends StatefulWidget {
  const MainScreen({super.key});

  @override
  State<MainScreen> createState() => _MainScreenState();
}

class _MainScreenState extends State<MainScreen> {
  int _currentIndex = 0;
  bool _isLoading = false;
  List<Relation> _relations = [];
  List<String> _onlineUsers = [];
  String _searchQuery = '';

  // Settings Controllers
  final _nicknameController = TextEditingController();
  final _oldPasswordController = TextEditingController();
  final _newPasswordController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _nicknameController.text = ApiService().currentNickname;
    _refreshData();
    _setupWebSocket();
  }

  @override
  void dispose() {
    _nicknameController.dispose();
    _oldPasswordController.dispose();
    _newPasswordController.dispose();
    super.dispose();
  }

  void _setupWebSocket() {
    ApiService().connectWebSocket(
      onMessageReceived: (msg) {
        // Trigger relations fetch on message to update last message/unread badge
        _fetchRelationsOnly();
      },
      onTypingReceived: (user, isTyping) {
        // Handle typing events globally if needed
      },
      onOnlineStatusReceived: (users) {
        if (mounted) {
          setState(() {
            _onlineUsers = users;
          });
        }
      },
    );
  }

  Future<void> _fetchRelationsOnly() async {
    final list = await ApiService().fetchRelations();
    if (mounted) {
      setState(() {
        _relations = list;
      });
    }
  }

  Future<void> _refreshData() async {
    setState(() {
      _isLoading = true;
    });
    final list = await ApiService().fetchRelations();
    if (mounted) {
      setState(() {
        _relations = list;
        _isLoading = false;
      });
    }
  }

  List<Relation> get _filteredRelations {
    final q = _searchQuery.trim().toLowerCase();
    List<Relation> list = _relations;
    if (q.isNotEmpty) {
      list = _relations.where((r) => r.name.toLowerCase().contains(q)).toList();
    }
    // Sort pinned relations to the top
    List<Relation> sortedList = List.from(list);
    sortedList.sort((a, b) {
      final aKey = '${a.type}_${a.type == 'group' ? a.id : a.targetUser}';
      final bKey = '${b.type}_${b.type == 'group' ? b.id : b.targetUser}';
      final aPinned = ApiService().pinnedKeys.contains(aKey) ? 1 : 0;
      final bPinned = ApiService().pinnedKeys.contains(bKey) ? 1 : 0;
      if (aPinned != bPinned) {
        return bPinned.compareTo(aPinned); // Pinned first
      }
      return 0;
    });
    return sortedList;
  }

  void _logout() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('确定注销？'),
        content: const Text('您将退出当前登录的账户，并清空本地缓存。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('确认登出'),
          ),
        ],
      ),
    );

    if (confirm == true) {
      await ApiService().logout();
      if (mounted) {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (context) => const LoginScreen()),
        );
      }
    }
  }

  void _changeAvatar() async {
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (pickedFile != null) {
      final bytes = await File(pickedFile.path).readAsBytes();
      final base64Image = 'data:image/png;base64,${base64.encode(bytes)}';
      setState(() {
        _isLoading = true;
      });
      final success = await ApiService().updateAvatar(base64Image);
      setState(() {
        _isLoading = false;
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(success ? '头像更换成功' : '更换头像失败，请重试'),
            backgroundColor: success ? Colors.green : Colors.red,
          ),
        );
      }
    }
  }

  void _confirmDeleteAccount() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('⚠️ 危险操作：确认注销账号？'),
        content: const Text('注销账号将永久删除您的个人资料、聊天记录、好友关系及所有相关数据，此操作不可逆！确认永久注销吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('确认永久注销', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );

    if (confirm == true) {
      final success = await ApiService().deleteAccount();
      if (success) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('您的账号已被永久注销')),
        );
        if (mounted) {
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(builder: (context) => const LoginScreen()),
          );
        }
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('注销失败，请稍后重试')),
        );
      }
    }
  }

  void _showMyQrCodeDialog() {
    final username = ApiService().currentUsername;
    final nickname = ApiService().currentNickname;
    final qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=openboard:add_friend:$username';

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('我的二维码名片', textAlign: TextAlign.center),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AvatarWidget(
              name: username,
              nickname: nickname,
              avatarUrl: ApiService().currentAvatar,
              size: 60,
            ),
            const SizedBox(height: 12),
            Text(
              nickname,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            Text(
              '@$username',
              style: TextStyle(color: Colors.grey.shade600, fontSize: 14),
            ),
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.05),
                    blurRadius: 10,
                  ),
                ],
              ),
              child: Image.network(
                qrUrl,
                width: 200,
                height: 200,
                fit: BoxFit.contain,
                loadingBuilder: (context, child, loadingProgress) {
                  if (loadingProgress == null) return child;
                  return const SizedBox(
                    width: 200,
                    height: 200,
                    child: Center(child: CircularProgressIndicator()),
                  );
                },
                errorBuilder: (context, error, stackTrace) {
                  return const SizedBox(
                    width: 200,
                    height: 200,
                    child: Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.broken_image, color: Colors.grey, size: 48),
                          SizedBox(height: 8),
                          Text('二维码加载失败', style: TextStyle(color: Colors.grey)),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 16),
            Text(
              '让好友扫描上方二维码，即可添加您为好友',
              style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
              textAlign: TextAlign.center,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  void _openChat(Relation item) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ChatScreen(
          relationId: item.id,
          title: item.name,
          targetUser: item.targetUser,
          isOnline: item.targetUser != null && _onlineUsers.contains(item.targetUser),
        ),
      ),
    );
    // Refresh when returning from chat to clear unread badges
    _fetchRelationsOnly();
  }

  void _showRelationActions(Relation item) {
    final key = '${item.type}_${item.type == 'group' ? item.id : item.targetUser}';
    final isPinned = ApiService().pinnedKeys.contains(key);

    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(isPinned ? Icons.vertical_align_bottom : Icons.vertical_align_top),
              title: Text(isPinned ? '取消置顶' : '置顶聊天'),
              onTap: () async {
                Navigator.pop(context);
                await ApiService().togglePin(key);
                setState(() {});
              },
            ),
          ],
        ),
      ),
    );
  }

  void _startScanFromHeader() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const ScanScreen()),
    );
    if (result != null && result.isNotEmpty) {
      // Decode result (invite link or server code)
      _handleQrResult(result);
    }
  }

  void _handleQrResult(String val) {
    // Check if link contains group invitation or user target
    // Examples: http://server/invite/group_123 or friend:username or openboard:add_friend:username
    final code = val.trim();
    if (code.startsWith('friend:')) {
      final username = code.substring(7);
      _showAddFriendDialog(username);
    } else if (code.startsWith('openboard:add_friend:')) {
      final username = Uri.decodeComponent(code.substring(21));
      _showAddFriendDialog(username);
    } else {
      showDialog(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('识别到二维码'),
          content: Text(code),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('确定')),
          ],
        ),
      );
    }
  }

  void _showAddFriendDialog(String username) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('添加好友'),
        content: Text('是否要添加用户 "@$username" 为好友？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              final success = await ApiService().sendFriendRequest(username);
              if (success) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('已向 @$username 发送好友申请'), backgroundColor: Colors.green),
                );
              } else {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('发送好友申请失败，该用户可能不存在或已是好友'), backgroundColor: Colors.red),
                );
              }
            },
            child: const Text('确定'),
          ),
        ],
      ),
    );
  }

  void _showSearchAndAddFriendDialog() {
    final searchController = TextEditingController();
    List<Map<String, dynamic>> searchResults = [];
    bool isSearching = false;

    showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('搜索并添加好友'),
          content: SizedBox(
            width: double.maxFinite,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: searchController,
                        decoration: const InputDecoration(
                          hintText: '输入用户名进行搜索',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    ElevatedButton(
                      onPressed: isSearching
                          ? null
                          : () async {
                              final query = searchController.text.trim();
                              if (query.isEmpty) return;
                              setDialogState(() {
                                isSearching = true;
                              });
                              final results = await ApiService().searchUsers(query);
                              setDialogState(() {
                                searchResults = results;
                                isSearching = false;
                              });
                            },
                      child: isSearching
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('搜索'),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                if (searchResults.isEmpty && searchController.text.isNotEmpty && !isSearching)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 20),
                    child: Text('无搜索结果', style: TextStyle(color: Colors.grey)),
                  )
                else
                  Flexible(
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: searchResults.length,
                      itemBuilder: (context, index) {
                        final user = searchResults[index];
                        final username = user['username'];
                        final nickname = user['nickname'] ?? username;
                        return ListTile(
                          title: Text(nickname),
                          subtitle: Text('@$username'),
                          trailing: ElevatedButton(
                            onPressed: () async {
                              final success = await ApiService().sendFriendRequest(username);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(success ? '已发送好友申请给 @$username' : '发送申请失败'),
                                  backgroundColor: success ? Colors.green : Colors.red,
                                ),
                              );
                            },
                            child: const Text('添加'),
                          ),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('关闭'),
            ),
          ],
        ),
      ),
    );
  }

  void _showFriendRequestsDialog() async {
    List<Map<String, dynamic>> requests = await ApiService().fetchFriendRequests();

    showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('好友申请列表'),
          content: SizedBox(
            width: double.maxFinite,
            child: requests.isEmpty
                ? const Padding(
                    padding: EdgeInsets.symmetric(vertical: 20),
                    child: Text('暂无好友申请', style: TextStyle(color: Colors.grey)),
                  )
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: requests.length,
                    itemBuilder: (context, index) {
                      final req = requests[index];
                      final fromUser = req['from_user'];
                      return ListTile(
                        title: Text(fromUser),
                        subtitle: const Text('向您发送了好友申请'),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            TextButton(
                              onPressed: () async {
                                final success = await ApiService().respondFriendRequest(fromUser, 'accept');
                                if (success) {
                                  final newRequests = await ApiService().fetchFriendRequests();
                                  setDialogState(() {
                                    requests = newRequests;
                                  });
                                  _fetchRelationsOnly(); // refresh friends list
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(content: Text('已同意好友申请'), backgroundColor: Colors.green),
                                  );
                                }
                              },
                              child: const Text('同意', style: TextStyle(color: Colors.green)),
                            ),
                            TextButton(
                              onPressed: () async {
                                final success = await ApiService().respondFriendRequest(fromUser, 'reject');
                                if (success) {
                                  final newRequests = await ApiService().fetchFriendRequests();
                                  setDialogState(() {
                                    requests = newRequests;
                                  });
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(content: Text('已拒绝好友申请')),
                                  );
                                }
                              },
                              child: const Text('拒绝', style: TextStyle(color: Colors.red)),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('关闭'),
            ),
          ],
        ),
      ),
    );
  }

  void _showCreateGroupDialog() {
    final controller = TextEditingController();
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('创建新群聊'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            labelText: '群组名称',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(
            onPressed: () async {
              final name = controller.text.trim();
              if (name.isNotEmpty) {
                Navigator.pop(context);
                // Call create group API
                _refreshData();
              }
            },
            child: const Text('创建'),
          ),
        ],
      ),
    );
  }

  void _showUpdateNicknameDialog() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('修改个人昵称'),
        content: TextField(
          controller: _nicknameController,
          decoration: const InputDecoration(
            labelText: '新昵称',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(
            onPressed: () async {
              final newNick = _nicknameController.text.trim();
              if (newNick.isNotEmpty) {
                final success = await ApiService().updateProfile(newNick);
                if (mounted) {
                  Navigator.pop(context);
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(success ? '昵称修改成功！' : '修改失败，请重试'),
                      backgroundColor: success ? Colors.green : Colors.red,
                    ),
                  );
                  setState(() {});
                }
              }
            },
            child: const Text('保存'),
          ),
        ],
      ),
    );
  }

  void _showChangePasswordDialog() {
    _oldPasswordController.clear();
    _newPasswordController.clear();
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('修改账户密码'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _oldPasswordController,
              obscureText: true,
              decoration: const InputDecoration(
                labelText: '当前旧密码',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _newPasswordController,
              obscureText: true,
              decoration: const InputDecoration(
                labelText: '设置新密码',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(
            onPressed: () async {
              final oldP = _oldPasswordController.text;
              final newP = _newPasswordController.text;
              if (oldP.isNotEmpty && newP.length >= 6) {
                final success = await ApiService().changePassword(oldP, newP);
                if (mounted) {
                  Navigator.pop(context);
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(success ? '密码修改成功！' : '修改失败，请检查旧密码输入'),
                      backgroundColor: success ? Colors.green : Colors.red,
                    ),
                  );
                }
              }
            },
            child: const Text('修改'),
          ),
        ],
      ),
    );
  }

  Widget _buildChatsTab() {
    return Column(
      children: [
        // Filter Search Bar
        Padding(
          padding: const EdgeInsets.all(12.0),
          child: TextField(
            onChanged: (val) {
              setState(() {
                _searchQuery = val;
              });
            },
            decoration: InputDecoration(
              hintText: '搜索联系人或群组...',
              prefixIcon: const Icon(Icons.search),
              contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 16),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(30.0),
                borderSide: BorderSide.none,
              ),
              filled: true,
              fillColor: Colors.grey.shade100,
            ),
          ),
        ),

        // Relations ListView
        Expanded(
          child: _isLoading
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _refreshData,
                  child: _filteredRelations.isEmpty
                      ? ListView(
                          children: const [
                            SizedBox(height: 100),
                            Center(
                              child: Text(
                                '暂无聊天会话，点击右上角加号发起。',
                                style: TextStyle(color: Colors.grey),
                              ),
                            )
                          ],
                        )
                      : ListView.separated(
                          itemCount: _filteredRelations.length,
                          separatorBuilder: (context, index) => const Divider(height: 1),
                          itemBuilder: (context, index) {
                            final item = _filteredRelations[index];
                            final isOnline = item.targetUser != null &&
                                _onlineUsers.contains(item.targetUser);
                            final key = '${item.type}_${item.type == 'group' ? item.id : item.targetUser}';
                            final isPinned = ApiService().pinnedKeys.contains(key);

                            return ListTile(
                              tileColor: isPinned ? Colors.blue.shade50.withOpacity(0.15) : null,
                              leading: AvatarWidget(
                                name: item.targetUser ?? (item.id == 0 ? 'lobby' : 'group_${item.id}'),
                                nickname: item.name,
                                avatarUrl: item.avatar,
                                isOnline: isOnline,
                              ),
                              title: Row(
                                children: [
                                  Text(
                                    item.name,
                                    style: const TextStyle(fontWeight: FontWeight.w600),
                                  ),
                                  if (item.type == 'group' && item.id != 0) ...[
                                    const SizedBox(width: 6),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                      decoration: BoxDecoration(
                                        color: Colors.blue.shade50,
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                      child: Text(
                                        '群组',
                                        style: TextStyle(fontSize: 9, color: Colors.blue.shade700),
                                      ),
                                    )
                                  ]
                                ],
                              ),
                              subtitle: Text(
                                item.id == 0
                                    ? '系统群聊'
                                    : (item.type == 'group' ? '群组' : '私聊'),
                                style: TextStyle(fontSize: 13, color: Colors.grey.shade500),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              trailing: isPinned ? Icon(Icons.push_pin, size: 16, color: Colors.blue.shade600) : null,
                              onTap: () => _openChat(item),
                              onLongPress: () => _showRelationActions(item),
                            );
                          },
                        ),
                ),
        )
      ],
    );
  }

  Widget _buildSettingsTab() {
    final api = ApiService();
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16.0),
      child: Column(
        children: [
          // User Card
          Card(
            elevation: 2,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            child: Padding(
              padding: const EdgeInsets.all(20.0),
              child: Row(
                children: [
                  AvatarWidget(
                    name: api.currentUsername,
                    nickname: api.currentNickname,
                    avatarUrl: api.currentAvatar,
                    size: 64,
                    onTap: _changeAvatar,
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          api.currentNickname,
                          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '@${api.currentUsername}',
                          style: TextStyle(color: Colors.grey.shade600),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.edit, color: Colors.blue),
                    onPressed: _showUpdateNicknameDialog,
                  )
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Action Items
          Card(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.qr_code, color: Colors.blue),
                  title: const Text('我的二维码名片'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _showMyQrCodeDialog,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.lock_outline, color: Colors.deepOrange),
                  title: const Text('修改账户密码'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _showChangePasswordDialog,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.logout, color: Colors.red),
                  title: const Text('安全退出登录'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _logout,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.delete_forever, color: Colors.red),
                  title: const Text('永久注销账号', style: TextStyle(color: Colors.red)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _confirmDeleteAccount,
                ),
              ],
            ),
          ),
          const SizedBox(height: 30),

          // App version info
          Text(
            '信语 OpenBoard Mobile v1.0.0',
            style: TextStyle(color: Colors.grey.shade400, fontSize: 12),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _currentIndex == 0 ? '信语 (OpenBoard)' : '个人设置',
          style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
        ),
        backgroundColor: Colors.blue.shade800,
        actions: [
          if (_currentIndex == 0) ...[
            IconButton(
              icon: const Icon(Icons.person_add, color: Colors.white),
              tooltip: '添加好友',
              onPressed: _showSearchAndAddFriendDialog,
            ),
            IconButton(
              icon: const Icon(Icons.people_outline, color: Colors.white),
              tooltip: '好友申请',
              onPressed: _showFriendRequestsDialog,
            ),
            IconButton(
              icon: const Icon(Icons.qr_code_scanner, color: Colors.white),
              tooltip: '扫码',
              onPressed: _startScanFromHeader,
            ),
            IconButton(
              icon: const Icon(Icons.group_add, color: Colors.white),
              tooltip: '建群',
              onPressed: _showCreateGroupDialog,
            ),
          ]
        ],
      ),
      body: IndexedStack(
        index: _currentIndex,
        children: [
          _buildChatsTab(),
          _buildSettingsTab(),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentIndex,
        selectedItemColor: Colors.blue.shade800,
        onTap: (index) {
          setState(() {
            _currentIndex = index;
          });
        },
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.chat_bubble_outline),
            activeIcon: Icon(Icons.chat_bubble),
            label: '聊天',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.settings_outlined),
            activeIcon: Icon(Icons.settings),
            label: '设置',
          ),
        ],
      ),
    );
  }
}
