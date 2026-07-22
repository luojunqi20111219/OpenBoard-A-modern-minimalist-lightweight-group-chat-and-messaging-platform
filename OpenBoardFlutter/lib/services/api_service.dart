import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/message.dart';
import '../models/relation.dart';

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
  }

  Future<void> setServerUrl(String url) async {
    _serverUrl = url;
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
      return {'success': false, 'message': data['detail'] ?? '登录失败'};
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

  Future<List<Message>> fetchHistory({int roomId = 0, String? targetUser}) async {
    if (_token.isEmpty) return [];

    String url = '$_serverUrl/api/messages';
    if (targetUser != null && targetUser.isNotEmpty) {
      url += '?target_user=$targetUser';
    } else {
      url += '?room_id=$roomId';
    }

    try {
      final response = await http.get(
        Uri.parse(url),
        headers: {'Authorization': _token},
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          final List<dynamic> list = data['data'] ?? [];
          return list.map((item) => Message.fromJson(item)).toList();
        }
      }
    } catch (e) {
      print('Fetch history error: $e');
    }
    return [];
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
      var request = http.MultipartRequest('POST', Uri.parse('$_serverUrl/api/messages/upload'));
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
      final response = await http.post(
        Uri.parse('$_serverUrl/api/messages/recall'),
        headers: {
          'Authorization': _token,
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'id': messageId}),
      );
      return response.statusCode == 200;
    } catch (_) {}
    return false;
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
}
