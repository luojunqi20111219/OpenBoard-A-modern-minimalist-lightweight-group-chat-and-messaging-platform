import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/message.dart';
import '../models/relation.dart';

class MessagePage {
  final List<Message> messages;
  final bool hasMore;
  final int? nextBeforeId;

  const MessagePage(this.messages, this.hasMore, this.nextBeforeId);
}

class ApiService {
  static final ApiService _instance = ApiService._internal();
  factory ApiService() => _instance;
  ApiService._internal();

  String _serverUrl = 'https://liuyan.luojunqi.xyz';
  String _token = '';
  String _currentUsername = '';
  String _currentNickname = '';
  String _currentAvatar = '';
  int _currentRole = 0;
  List<String> _pinnedKeys = [];

  WebSocketChannel? _wsChannel;
  bool _wsConnected = false;
  bool _shouldReconnect = false;
  Function(Message)? _onMessageReceived;
  Function(String, bool)? _onTypingReceived;
  Function(List<String>)? _onOnlineStatusReceived;

  String get serverUrl => _serverUrl;
  String get token => _token;
  String get currentUsername => _currentUsername;
  String get currentNickname => _currentNickname;
  String get currentAvatar => _currentAvatar;
  int get currentRole => _currentRole;
  bool get wsConnected => _wsConnected;
  List<String> get pinnedKeys => _pinnedKeys;

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _serverUrl = prefs.getString('server_url') ?? 'https://liuyan.luojunqi.xyz';
    _token = prefs.getString('token') ?? '';
    _currentUsername = prefs.getString('username') ?? '';
    _currentNickname = prefs.getString('nickname') ?? '';
    _currentAvatar = prefs.getString('avatar') ?? '';
    _currentRole = prefs.getInt('role') ?? 0;
    _pinnedKeys = prefs.getStringList('pinned_keys') ?? [];
    await _loadConversationSettings();
  }

  Future<void> setServerUrl(String url) async {
    _serverUrl = url;
    // 换了服务器就要重探能力 —— 否则会沿用上一台服务器的结论，
    // 在支持自助重置的服务器上不显示按钮，或者反过来。
    resetCapabilityCache();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_url', url);
  }

  Future<Map<String, dynamic>> login(String username, String password) async {
    final response = await http.post(
      Uri.parse('$_serverUrl/api/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': username, 'password': password}),
    );

    final data = jsonDecode(response.body);
    if (response.statusCode == 200) {
      _token = data['token'] ?? '';
      _currentUsername = username;
      _currentNickname = data['nickname'] ?? username;
      _currentAvatar = data['avatar'] ?? '';
      _currentRole = data['role'] ?? 0;

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('token', _token);
      await prefs.setString('username', _currentUsername);
      await prefs.setString('nickname', _currentNickname);
      await prefs.setString('avatar', _currentAvatar);
      await prefs.setInt('role', _currentRole);
      return {'success': true};
    } else {
      // ---------------------------------------------------------------------
      // 失败时把完整响应体带回去，而不是只留一句 detail。
      //
      // 原因：400 有两种完全不同的含义 ——
      //   · 普通参数错误            → 只有 detail
      //   · PASSWORD_RESET_REQUIRED → detail + code + admin_contact
      //                                 （含自助重置通道的全部信息）
      // 只传 detail 的话，登录页就没法区分这两种，只能一律弹「登录失败」，
      // 而后者恰恰是最需要解释清楚的一种：用户的密码根本没输错，
      // 只是这个账号的密码是旧版格式、服务器算不动校验。
      // 笼统报错会让人反复重试密码，白白触发登录锁定。
      // ---------------------------------------------------------------------
      return {
        'success': false,
        'message': data['detail'] ?? '登录失败',
        'status': response.statusCode,
        // 完整响应体，供调用方按 code 分流
        'body': data is Map<String, dynamic> ? data : <String, dynamic>{},
      };
    }
  }

  // =========================================================================
  // 自助重置为默认密码
  // =========================================================================
  // 背景：旧库里 werkzeug 默认的 scrypt:32768:8:1 哈希，验证一次约 75ms CPU，
  // 而 Cloudflare Free 计划单请求 CPU 上限 10ms —— 物理上算不完。
  // 这批账号**任何人**都登录不了（包括管理员）。原来的提示是「请联系管理员」，
  // 但管理员是谁、怎么联系，客户端给不出答案，用户就卡死了。
  //
  // 所以服务端补了 /api/reset-to-default，让用户自己把废账号的密码重置成
  // 默认密码，登进去后再强制改密。
  // =========================================================================

  /// 是否支持自助重置（缓存结果，避免每次登录都探一遍）
  bool _supportsSelfReset = false;
  bool get supportsSelfReset => _supportsSelfReset;

  /// 是否已经针对当前服务器地址探测过
  bool _capabilitiesProbed = false;

  /// 服务端下发的默认密码（探测不到时为 null，由调用方回退）
  String? _serverDefaultPassword;
  String? get serverDefaultPassword => _serverDefaultPassword;

  /// 换服务器地址时重置探测缓存 —— 否则换了服务器还用上一个服务器结论
  void resetCapabilityCache() {
    _capabilitiesProbed = false;
    _supportsSelfReset = false;
    _serverDefaultPassword = null;
  }

  /// 静默探测服务端能力（GET /api/capabilities）。
  ///
  /// `self_reset_password` 这个能力**只存在于 Cloudflare Workers 版服务端**。
  /// FastAPI 版或老版 CF 版都没有这个接口。客户端必须先问一句，
  /// 确认支持才显示「重置为默认密码」按钮 —— 否则用户点下去会拿到 404
  /// 或一坨 HTML 错误页，既不知道发生了什么，也不知道该怎么办，
  /// 比不显示按钮还糟。
  ///
  /// **探测失败 = 不支持**（默认关闭），而不是"探测失败也先显示着试试看"。
  /// 这个方法不抛异常、不提示用户 —— 它只影响一个按钮显不显示，
  /// 失败没有任何副作用，所以是"尽力而为"。
  Future<bool> probeCapabilities({bool force = false}) async {
    if (_capabilitiesProbed && !force) return _supportsSelfReset;

    try {
      final response = await http
          .get(Uri.parse('$_serverUrl/api/capabilities'))
          .timeout(const Duration(seconds: 8));

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        // 三层都得对：合法 JSON + features 存在 + 字段严格等于 true
        if (data is Map &&
            data['features'] is Map &&
            data['features']['self_reset_password'] == true) {
          _supportsSelfReset = true;
        }
      }
    } catch (_) {
      // 404 / 超时 / 非 JSON / 网关错误页 —— 一律按不支持
      _supportsSelfReset = false;
    }

    _capabilitiesProbed = true;
    return _supportsSelfReset;
  }

  /// 自助把密码重置为默认密码。
  ///
  /// 不需要鉴权 —— 能走到这一步的用户恰恰是登不上的人。
  ///
  /// 返回 `{'success': bool, 'message': String, 'default_password': String?,
  ///       'status': int}`。
  /// 四个失败原因（今天重置过 / 账号无需重置 / 管理员账号 / 用户不存在）
  /// 全靠服务端 detail 区分，所以这里原样带回，别自己编文案。
  Future<Map<String, dynamic>> resetToDefault(String username) async {
    try {
      final response = await http
          .post(
            Uri.parse('$_serverUrl/api/reset-to-default'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'username': username}),
          )
          .timeout(const Duration(seconds: 20));

      Map<String, dynamic> data = <String, dynamic>{};
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map<String, dynamic>) data = decoded;
      } catch (_) {
        // 非 JSON 响应（网关错误页等）—— 下面按状态码处理
      }

      if (response.statusCode == 200) {
        final pwd = data['default_password'] as String?;
        if (pwd != null && pwd.isNotEmpty) {
          _serverDefaultPassword = pwd;
        }
        return {
          'success': true,
          'message': data['msg'] ?? '密码已重置',
          'default_password': pwd,
          'status': response.statusCode,
        };
      }
      return {
        'success': false,
        'message': data['detail'] ?? '重置失败（HTTP ${response.statusCode}）',
        'status': response.statusCode,
      };
    } catch (e) {
      return {
        'success': false,
        'message': '网络错误：无法连接服务器',
        'status': 0,
      };
    }
  }

  Future<Map<String, dynamic>> register(String username, String password, String nickname) async {
    final response = await http.post(
      Uri.parse('$_serverUrl/api/register'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'username': username,
        'password': password,
        'nickname': nickname.isEmpty ? username : nickname,
      }),
    );

    final data = jsonDecode(response.body);
    if (response.statusCode == 200) {
      return {'success': true};
    } else {
      return {'success': false, 'message': data['detail'] ?? '注册失败'};
    }
  }

  Future<void> logout() async {
    _token = '';
    _currentUsername = '';
    _currentNickname = '';
    _currentRole = 0;
    disconnectWebSocket();

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('token');
    await prefs.remove('username');
    await prefs.remove('nickname');
    await prefs.remove('role');

    try {
      await http.post(
        Uri.parse('$_serverUrl/api/logout'),
        headers: {'Authorization': _token},
      );
    } catch (_) {}
  }

  Future<List<Relation>> fetchRelations() async {
    if (_token.isEmpty) return [];
    
    // We fetch groups and friends
    try {
      final groupsResponse = await http.get(
        Uri.parse('$_serverUrl/api/groups'),
        headers: {'Authorization': _token},
      );
      final friendsResponse = await http.get(
        Uri.parse('$_serverUrl/api/friends'),
        headers: {'Authorization': _token},
      );

      final List<Relation> relations = [];



      if (groupsResponse.statusCode == 200) {
        final groupsData = jsonDecode(groupsResponse.body);
        if (groupsData['status'] == 'success') {
          for (var item in groupsData['data']) {
            relations.add(Relation(
              id: item['id'],
              name: item['name'],
              type: 'group',
              avatar: item['avatar'],
            ));
          }
        }
      }

      if (friendsResponse.statusCode == 200) {
        final friendsData = jsonDecode(friendsResponse.body);
        if (friendsData['status'] == 'success') {
          for (var item in friendsData['data']) {
            relations.add(Relation(
              id: 0,
              name: item['nickname'] ?? item['username'],
              type: 'friend',
              targetUser: item['username'],
              avatar: item['avatar'],
            ));
          }
        }
      }

      return relations;
    } catch (e) {
      print('Fetch relations error: $e');
      return [Relation(id: 0, name: '公共大厅', type: 'group')];
    }
  }

  Future<MessagePage> fetchHistoryPage({
    int roomId = 0,
    String? targetUser,
    int? beforeId,
    int limit = 50,
  }) async {
    if (_token.isEmpty) return const MessagePage([], false, null);

    final query = <String, String>{'limit': '$limit'};
    if (targetUser != null && targetUser.isNotEmpty) query['target_user'] = targetUser;
    if (targetUser == null || targetUser.isEmpty) query['room_id'] = '$roomId';
    if (beforeId != null) query['before_id'] = '$beforeId';
    final uri = Uri.parse('$_serverUrl/api/messages').replace(queryParameters: query);

    try {
      final response = await http.get(
        uri,
        headers: {'Authorization': _token},
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          final List<dynamic> list = data['data'] ?? [];
          final messages = list.map((item) => Message.fromJson(item)).toList();
          final pagination = data['pagination'] as Map<String, dynamic>?;
          return MessagePage(
            messages,
            pagination?['has_more'] == true,
            pagination?['next_before_id'],
          );
        }
      }
    } catch (e) {
      print('Fetch history error: $e');
    }
    return const MessagePage([], false, null);
  }

  Future<List<Message>> fetchHistory({int roomId = 0, String? targetUser}) async {
    return (await fetchHistoryPage(roomId: roomId, targetUser: targetUser)).messages;
  }

  Future<bool> updateProfile(String nickname) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/user/profile'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'nickname': nickname}),
      );
      if (response.statusCode == 200) {
        _currentNickname = nickname;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('nickname', nickname);
        return true;
      }
    } catch (_) {}
    return false;
  }

  Future<bool> updateAvatar(String base64Image) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/user/profile'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'avatar': base64Image}),
      );
      if (response.statusCode == 200) {
        _currentAvatar = base64Image;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('avatar', base64Image);
        return true;
      }
    } catch (_) {}
    return false;
  }

  Future<bool> changePassword(String oldPassword, String newPassword) async {
    try {
      final response = await http.put(
        Uri.parse('$_serverUrl/api/user/password'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'old_password': oldPassword,
          'new_password': newPassword,
        }),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> deleteAccount() async {
    try {
      final response = await http.delete(
        Uri.parse('$_serverUrl/api/user/account'),
        headers: {'Authorization': _token},
      );
      if (response.statusCode == 200) {
        _token = '';
        _currentUsername = '';
        _currentNickname = '';
        _currentRole = 0;
        final prefs = await SharedPreferences.getInstance();
        await prefs.remove('token');
        await prefs.remove('username');
        await prefs.remove('nickname');
        await prefs.remove('role');
        return true;
      }
    } catch (_) {}
    return false;
  }

  Future<String?> uploadAttachment(File file) async {
    try {
      var request = http.MultipartRequest('POST', Uri.parse('$_serverUrl/api/upload'));
      request.headers['Authorization'] = _token;
      request.files.add(await http.MultipartFile.fromPath('file', file.path));
      
      var streamedResponse = await request.send();
      var response = await http.Response.fromStream(streamedResponse);
      
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          return data['url'];
        }
      }
    } catch (e) {
      print('Upload attachment error: $e');
    }
    return null;
  }

  Future<bool> recallMessage(int messageId) async {
    try {
      final response = await http.delete(
        Uri.parse('$_serverUrl/api/messages/$messageId'),
        headers: {
          'Authorization': _token,
        },
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> forwardMessage(int messageId, {int roomId = 0, String? receiver}) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/messages/$messageId/forward'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'room_id': roomId,
          if (receiver != null) 'receiver': receiver,
        }),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> editMessage(int messageId, String content) async {
    try {
      final response = await http.put(
        Uri.parse('$_serverUrl/api/messages/$messageId'),
        headers: {'Authorization': _token, 'Content-Type': 'application/json'},
        body: jsonEncode({'content': content}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> favoriteMessage(int messageId, {bool remove = false}) async {
    try {
      final uri = Uri.parse('$_serverUrl/api/favorites/messages/$messageId');
      final response = remove
          ? await http.delete(uri, headers: {'Authorization': _token})
          : await http.post(uri, headers: {'Authorization': _token});
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<void> markMessagesRead(int upToId, {int roomId = 0, String? targetUser}) async {
    try {
      await http.post(
        Uri.parse('$_serverUrl/api/messages/read'),
        headers: {'Authorization': _token, 'Content-Type': 'application/json'},
        body: jsonEncode({'up_to_id': upToId, 'room_id': roomId, 'target_user': targetUser}),
      );
    } catch (_) {}
  }

  Future<List<Message>> searchMessages(String query, {int roomId = 0, String? targetUser}) async {
    try {
      final params = <String, String>{'q': query, 'limit': '30'};
      if (targetUser != null) params['target_user'] = targetUser;
      if (targetUser == null) params['room_id'] = '$roomId';
      final uri = Uri.parse('$_serverUrl/api/messages/search').replace(queryParameters: params);
      final response = await http.get(uri, headers: {'Authorization': _token});
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return (data['data'] as List<dynamic>? ?? []).map((item) => Message.fromJson(item)).toList();
      }
    } catch (_) {}
    return [];
  }

  void connectWebSocket({
    required Function(Message) onMessageReceived,
    required Function(String, bool) onTypingReceived,
    required Function(List<String>) onOnlineStatusReceived,
  }) {
    if (_token.isEmpty) return;
    _onMessageReceived = onMessageReceived;
    _onTypingReceived = onTypingReceived;
    _onOnlineStatusReceived = onOnlineStatusReceived;
    _shouldReconnect = true;
    _connect();
  }

  void _connect() {
    if (!_shouldReconnect || _token.isEmpty) return;
    disconnectWebSocketOnly();

    // Convert http/https to ws/wss
    String wsUrl = _serverUrl.replaceAll('http://', 'ws://').replaceAll('https://', 'wss://');
    wsUrl += '/ws/$_token';

    try {
      _wsChannel = IOWebSocketChannel.connect(
        Uri.parse(wsUrl),
        pingInterval: const Duration(seconds: 30),
      );
      _wsConnected = true;

      _wsChannel!.stream.listen(
        (data) {
          try {
            final Map<String, dynamic> event = jsonDecode(data);
            final type = event['type'];

            if (type == 'message' && _onMessageReceived != null) {
              final msg = Message.fromJson(event['data']);
              _onMessageReceived!(msg);
            } else if (type == 'typing' && _onTypingReceived != null) {
              final user = event['user'] ?? '';
              final isTyping = event['is_typing'] ?? false;
              if (user != _currentUsername) {
                _onTypingReceived!(user, isTyping);
              }
            } else if (type == 'online_status' && _onOnlineStatusReceived != null) {
              final List<dynamic> rawList = event['users'] ?? [];
              final List<String> users = rawList.map((e) => e.toString()).toList();
              _onOnlineStatusReceived!(users);
            }
          } catch (e) {
            print('WS event parse error: $e');
          }
        },
        onDone: () {
          _wsConnected = false;
          print('WS closed.');
          _triggerReconnect();
        },
        onError: (err) {
          _wsConnected = false;
          print('WS error: $err');
          _triggerReconnect();
        },
      );
    } catch (e) {
      _wsConnected = false;
      print('WS connect error: $e');
      _triggerReconnect();
    }
  }

  void _triggerReconnect() {
    if (!_shouldReconnect) return;
    Future.delayed(const Duration(seconds: 5), () {
      if (_shouldReconnect && !_wsConnected) {
        _connect();
      }
    });
  }

  void sendTypingStatus(bool isTyping, {int roomId = 0, String? targetUser}) {
    if (_wsChannel == null || !_wsConnected) return;

    try {
      final payload = {
        'type': 'typing',
        'is_typing': isTyping,
        'room_id': roomId,
        'target_user': targetUser,
      };
      _wsChannel!.sink.add(jsonEncode(payload));
    } catch (_) {}
  }

  void disconnectWebSocketOnly() {
    if (_wsChannel != null) {
      _wsChannel!.sink.close();
      _wsChannel = null;
      _wsConnected = false;
    }
  }

  void disconnectWebSocket() {
    _shouldReconnect = false;
    disconnectWebSocketOnly();
  }

  Future<List<Map<String, dynamic>>> searchUsers(String query) async {
    try {
      final response = await http.get(
        Uri.parse('$_serverUrl/api/users/search?q=$query'),
        headers: {'Authorization': _token},
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          return List<Map<String, dynamic>>.from(data['data']);
        }
      }
    } catch (e) {
      print('Search users error: $e');
    }
    return [];
  }

  Future<bool> sendFriendRequest(String targetUsername) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/friends/request'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'to_user': targetUsername}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> addFriendDirectly(String targetUsername) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/friends/add'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'username': targetUsername}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<List<Map<String, dynamic>>> fetchFriendRequests() async {
    try {
      final response = await http.get(
        Uri.parse('$_serverUrl/api/friends/requests'),
        headers: {'Authorization': _token},
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          return List<Map<String, dynamic>>.from(data['data']);
        }
      }
    } catch (e) {
      print('Fetch requests error: $e');
    }
    return [];
  }

  Future<bool> respondFriendRequest(String fromUser, String action) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/friends/respond'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'from_user': fromUser, 'action': action}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> removeFriend(String username) async {
    try {
      final response = await http.delete(
        Uri.parse('$_serverUrl/api/friends/$username'),
        headers: {'Authorization': _token},
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<void> togglePin(String key) async {
    final prefs = await SharedPreferences.getInstance();
    if (_pinnedKeys.contains(key)) {
      _pinnedKeys.remove(key);
    } else {
      _pinnedKeys.add(key);
    }
    await prefs.setStringList('pinned_keys', _pinnedKeys);
    final conversationKey = key.startsWith('group_')
        ? 'room:${key.substring(6)}'
        : key.startsWith('friend_')
            ? 'user:${key.substring(7)}'
            : key;
    try {
      await http.put(
        Uri.parse('$_serverUrl/api/conversation-settings'),
        headers: {'Authorization': _token, 'Content-Type': 'application/json'},
        body: jsonEncode({
          'conversation_key': conversationKey,
          'is_pinned': _pinnedKeys.contains(key),
          'is_muted': false,
        }),
      );
    } catch (_) {}
  }

  Future<void> _loadConversationSettings() async {
    if (_token.isEmpty) return;
    try {
      final response = await http.get(
        Uri.parse('$_serverUrl/api/conversation-settings'),
        headers: {'Authorization': _token},
      );
      if (response.statusCode != 200) return;
      final data = jsonDecode(response.body);
      final remote = <String>[];
      for (final item in data['data'] ?? []) {
        if (item['is_pinned'] != 1) continue;
        final value = item['conversation_key'] as String;
        remote.add(value.startsWith('room:')
            ? 'group_${value.substring(5)}'
            : value.startsWith('user:')
                ? 'friend_${value.substring(5)}'
                : value);
      }
      if (remote.isNotEmpty) {
        _pinnedKeys = remote;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setStringList('pinned_keys', _pinnedKeys);
      }
    } catch (_) {}
  }

  Future<List<String>> fetchFavoriteEmojis() async {
    try {
      final response = await http.get(
        Uri.parse('$_serverUrl/api/favorites/emojis'),
        headers: {'Authorization': _token},
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          return List<String>.from(data['data']);
        }
      }
    } catch (e) {
      print('Fetch favorite emojis error: $e');
    }
    return [];
  }

  Future<bool> addFavoriteEmoji(String emoji) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/favorites/emojis'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'emoji': emoji}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> removeFavoriteEmoji(String emoji) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/favorites/emojis/delete'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'emoji': emoji}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<List<Map<String, dynamic>>> fetchLoginDevices() async {
    try {
      final response = await http.get(
        Uri.parse('$_serverUrl/api/user/devices'),
        headers: {'Authorization': _token},
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          return List<Map<String, dynamic>>.from(data['data']);
        }
      }
    } catch (e) {
      print('Fetch devices error: $e');
    }
    return [];
  }

  Future<bool> logoutDevice(String deviceId) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/user/devices/$deviceId/logout'),
        headers: {'Authorization': _token},
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }

  Future<bool> logoutAllDevices(String password) async {
    try {
      final response = await http.post(
        Uri.parse('$_serverUrl/api/user/logout-all'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'password': password}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
  }
}
