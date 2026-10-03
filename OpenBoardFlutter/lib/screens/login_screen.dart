import 'package:flutter/material.dart';
import '../services/api_service.dart';
import 'main_screen.dart';
import 'scan_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _serverController = TextEditingController();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _nicknameController = TextEditingController();

  bool _isRegister = false;
  bool _isLoading = false;
  final _formKey = GlobalKey<FormState>();

  // -------------------------------------------------------------------------
  // 密码重置提示状态
  //
  // 背景：旧库里 werkzeug 默认的 scrypt:32768:8:1 哈希，验证一次约 75ms CPU，
  // 而 Cloudflare Free 计划单请求 CPU 上限 10ms —— 物理上算不完。
  // 这批账号**任何人**都登录不了（包括管理员）。原来的提示是「请联系管理员」，
  // 但管理员是谁、怎么联系，客户端给不出答案，用户就卡死了。
  //
  // 所以服务端补了 /api/reset-to-default，让用户自己把废账号的密码重置成
  // 默认密码，登进去后再强制改密。
  // -------------------------------------------------------------------------

  /// 是否展示「需要重置密码」提示卡片
  bool _showResetHint = false;
  String _resetTitle = '';
  String _resetMessage = '';
  List<String> _resetAdmins = [];
  String _resetDefaultPassword = '';
  /// 是否显示「重置为默认密码」按钮（能力探测通过才为 true）
  bool _canSelfReset = false;

  @override
  void initState() {
    super.initState();
    _serverController.text = ApiService().serverUrl;
    // 静默探一次服务端能力 —— 只影响按钮显不显示，失败无副作用，所以不等它
    _probeCapabilities();
  }

  /// 探测服务端是否支持自助重置（不提示用户、不阻塞界面）
  Future<void> _probeCapabilities() async {
    await ApiService().probeCapabilities();
    if (mounted) {
      // 只更新状态，不重建提示卡 —— 探测通常早于用户触发登录失败
      setState(() {});
    }
  }

  @override
  void dispose() {
    _serverController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    _nicknameController.dispose();
    super.dispose();
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Colors.red.shade700,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  /// 收起重置提示卡片（切到注册页 / 登录成功时调用）
  void _dismissResetHint() {
    _showResetHint = false;
    _resetTitle = '';
    _resetMessage = '';
    _resetAdmins = [];
    _canSelfReset = false;
  }

  /// 渲染「需要重置密码」提示卡片。
  ///
  /// 按钮显示条件（两条路任一成立即显示）：
  ///   1. 服务端在 400 响应里**明确**说了 self_service == true
  ///   2. 或者能力探测接口确认过这台服务器支持
  ///
  /// ⚠️ 这里没有「?? true」这种宽松兜底。老服务端的 400 带 admin_contact
  ///    但不带 self_service；普通版服务端连 admin_contact 都没有。
  ///    这两种情况下如果按「没说不支持就是支持」推断，就会显示一个点了
  ///    必然失败的按钮。所以：说不清楚 = 不支持。
  void _renderResetHint(Map<String, dynamic> body) {
    final contact = (body['admin_contact'] as Map?)?.cast<String, dynamic>() ?? {};

    _resetTitle = (contact['title'] as String?) ?? '该账号需要重置密码';
    _resetMessage = (contact['message'] as String?) ??
        ((body['reason'] as String?) ?? '该账号的密码为旧版格式，当前服务器无法自动校验') +
            '。可以把它重置为默认密码后登录，登录后请立即修改。';

    final adminsRaw = contact['admins'];
    _resetAdmins = adminsRaw is List
        ? adminsRaw.map((e) => e.toString()).where((s) => s.trim().isNotEmpty).toList()
        : <String>[];

    // 默认密码优先用服务端下发的，避免客户端与服务端硬编码不一致时按钮文案对不上
    final pwd = contact['default_password'] as String?;
    _resetDefaultPassword =
        (pwd != null && pwd.isNotEmpty) ? pwd : (ApiService().serverDefaultPassword ?? '12345678');

    // 服务端明确声明 || 探测已确认
    _canSelfReset = contact['self_service'] == true || ApiService().supportsSelfReset;
    _showResetHint = true;
  }

  /// 二次确认后再重置。
  ///
  /// 为什么一定要确认：这个操作**不可逆** —— 旧密码会立刻作废，
  /// 而且新版是密码哈希，服务端也"算不回"原密码。
  /// 误触的代价是用户彻底登不上，所以必须让他明确知道自己在做什么。
  Future<void> _confirmResetToDefault() async {
    final username = _usernameController.text.trim();
    if (username.isEmpty) {
      _showError('请先填写用户名');
      return;
    }
    final pwd = _resetDefaultPassword;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('确认重置密码？'),
        content: Text(
          '将把「$username」的密码设为 $pwd。\n\n'
          '• 原来的密码会立即失效，无法找回\n'
          '• 登录后系统会要求您马上设置新密码\n'
          '• 每个账号每天只能重置一次',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.orange.shade800),
            child: const Text('确认重置'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    await _doResetToDefault(username, pwd);
  }

  Future<void> _doResetToDefault(String username, String fallbackPwd) async {
    setState(() => _isLoading = true);

    final res = await ApiService().resetToDefault(username);

    if (!mounted) return;

    if (res['success'] == true) {
      final pwd = (res['default_password'] as String?) ?? fallbackPwd;

      // 直接把密码填进去，用户点一下「登录」就走完了 —— 少一步手抄
      _passwordController.text = pwd;

      setState(() {
        _isLoading = false;
        _showResetHint = true;
        _canSelfReset = false; // 已重置，按钮撤掉
        _resetTitle = '密码已重置';
        _resetMessage = '默认密码 $pwd 已自动填入，点「立即登录」即可。登录后请立即设置新密码。';
        _resetAdmins = [];
      });

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('已重置，请点「立即登录」'),
          backgroundColor: Colors.green,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } else {
      // 四个失败原因（今天重置过 / 账号无需重置 / 管理员账号 / 不存在）
      // 全靠服务端 detail 区分，所以原样展示，别自己编文案
      setState(() => _isLoading = false);
      _showError((res['message'] as String?) ?? '重置失败');
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
    });

    try {
      // 1. Save and apply server URL
      await ApiService().setServerUrl(_serverController.text.trim());

      if (_isRegister) {
        // 2. Register flow
        final regRes = await ApiService().register(
          _usernameController.text.trim(),
          _passwordController.text.trim(),
          _nicknameController.text.trim(),
        );

        if (regRes['success']) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('注册成功，请登录！'), backgroundColor: Colors.green),
          );
          setState(() {
            _isRegister = false;
            _isLoading = false;
          });
        } else {
          _showError(regRes['message']);
          setState(() {
            _isLoading = false;
          });
        }
      } else {
        // 3. Login flow
        final loginRes = await ApiService().login(
          _usernameController.text.trim(),
          _passwordController.text.trim(),
        );

        if (loginRes['success']) {
          if (mounted) {
            Navigator.pushReplacement(
              context,
              MaterialPageRoute(builder: (context) => const MainScreen()),
            );
          }
        } else {
          // ---------------------------------------------------------------
          // 登录失败按原因分流，不能一句「登录失败」包打天下。
          //
          // 400 恰恰是最需要解释清楚的一种：用户的密码**根本没输错**，
          // 只是这个账号的密码是旧版格式、服务器算不动校验。
          // 笼统报错会让人反复重试密码，白白触发登录锁定。
          // ---------------------------------------------------------------
          final body = (loginRes['body'] as Map?)?.cast<String, dynamic>();

          if (body != null && body['code'] == 'PASSWORD_RESET_REQUIRED') {
            // 顺带再探一次能力 —— 首次探测可能因为网络抖动失败了
            await ApiService().probeCapabilities();
            if (!mounted) return;
            setState(() {
              _isLoading = false;
              _renderResetHint(body);
            });
            // 让用户的视线落到提示卡上
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('该账号需要重置密码，请看下方说明'),
                backgroundColor: Colors.orange,
                behavior: SnackBarBehavior.floating,
              ),
            );
          } else {
            _showError((loginRes['message'] as String?) ?? '登录失败');
            setState(() {
              _isLoading = false;
            });
          }
        }
      }
    } catch (e) {
      _showError('连接服务器失败，请检查服务地址。');
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _startQrScan() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const ScanScreen()),
    );
    if (result != null && result.isNotEmpty) {
      // If result contains QR code, check if it's a URL or server code
      if (result.startsWith('http://') || result.startsWith('https://')) {
        setState(() {
          _serverController.text = result;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已通过扫码设置服务器: $result'), backgroundColor: Colors.blue),
        );
      } else {
        _showError('无法识别的服务器二维码: $result');
      }
    }
  }

  void _showServerSettingsDialog() {
    final tempController = TextEditingController(text: _serverController.text);
    showDialog(
      context: context,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: const Text('设置服务器地址'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: tempController,
                          decoration: const InputDecoration(
                            labelText: '服务器地址',
                            hintText: 'https://liuyan.luojunqi.xyz',
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        icon: const Icon(Icons.qr_code_scanner),
                        onPressed: () async {
                          final result = await Navigator.push<String>(
                            context,
                            MaterialPageRoute(builder: (context) => const ScanScreen()),
                          );
                          if (result != null && result.isNotEmpty) {
                            if (result.startsWith('http://') || result.startsWith('https://')) {
                              setDialogState(() {
                                tempController.text = result;
                              });
                            } else {
                              _showError('无法识别的服务器二维码: $result');
                            }
                          }
                        },
                      ),
                    ],
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                TextButton(
                  onPressed: () async {
                    final newUrl = tempController.text.trim();
                    if (newUrl.isEmpty) {
                      _showError('服务器地址不能为空');
                      return;
                    }
                    setState(() {
                      _serverController.text = newUrl;
                    });
                    await ApiService().setServerUrl(newUrl);
                    if (mounted) {
                      Navigator.pop(context);
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('服务器地址已更新'), backgroundColor: Colors.green),
                      );
                    }
                  },
                  child: const Text('保存'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, color: Colors.white),
            onSelected: (value) {
              if (value == 'settings') {
                _showServerSettingsDialog();
              }
            },
            itemBuilder: (BuildContext context) => [
              const PopupMenuItem<String>(
                value: 'settings',
                child: Row(
                  children: [
                    Icon(Icons.settings, color: Colors.black54),
                    SizedBox(width: 8),
                    Text('设置服务器地址'),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
      extendBodyBehindAppBar: true,
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [Colors.blue.shade800, Colors.blue.shade500],
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28.0),
              child: Card(
                elevation: 8.0,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16.0)),
                child: Padding(
                  padding: const EdgeInsets.all(24.0),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.chat_bubble_outline,
                          size: 52,
                          color: Colors.blue,
                        ),
                        const SizedBox(height: 12.0),
                        Text(
                          _isRegister ? '加入信语 (OpenBoard)' : '登录信语 (OpenBoard)',
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.bold,
                            color: Colors.black87,
                          ),
                        ),
                        const SizedBox(height: 20.0),

                        // Username Input
                        TextFormField(
                          controller: _usernameController,
                          decoration: const InputDecoration(
                            labelText: '用户名',
                            prefixIcon: Icon(Icons.person),
                            border: OutlineInputBorder(),
                          ),
                          validator: (value) {
                            if (value == null || value.trim().isEmpty) {
                              return '请输入用户名';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 16.0),

                        if (_isRegister) ...[
                          // Nickname Input (only during registration)
                          TextFormField(
                            controller: _nicknameController,
                            decoration: const InputDecoration(
                              labelText: '昵称（选填）',
                              prefixIcon: Icon(Icons.face),
                              border: OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 16.0),
                        ],

                        // Password Input
                        TextFormField(
                          controller: _passwordController,
                          obscureText: true,
                          decoration: const InputDecoration(
                            labelText: '密码',
                            prefixIcon: Icon(Icons.lock),
                            border: OutlineInputBorder(),
                          ),
                          validator: (value) {
                            if (value == null || value.trim().length < 6) {
                              return '密码长度不能少于6位';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 24.0),

                        // -----------------------------------------------------
                        // 密码重置提示卡片
                        //
                        // 只在服务端明确支持时才带「重置为默认密码」按钮
                        // （见 _renderResetHint）。不支持时就只展示原因 +
                        // 管理员名字 —— 用户至少知道该找谁，而不是面对一个
                        // 点了必然失败的按钮。
                        // -----------------------------------------------------
                        if (_showResetHint) ...[
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(14.0),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFEF3C7),
                              borderRadius: BorderRadius.circular(12.0),
                              border: Border.all(color: const Color(0xFFFCD34D)),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _resetTitle,
                                  style: const TextStyle(
                                    fontSize: 15.0,
                                    fontWeight: FontWeight.bold,
                                    color: Color(0xFF92400E),
                                  ),
                                ),
                                const SizedBox(height: 8.0),
                                Text(
                                  _resetMessage,
                                  style: const TextStyle(
                                    fontSize: 12.5,
                                    color: Color(0xFFB45309),
                                    height: 1.5,
                                  ),
                                ),
                                if (_resetAdmins.isNotEmpty) ...[
                                  const SizedBox(height: 8.0),
                                  Text(
                                    '管理员：${_resetAdmins.join(' · ')}',
                                    style: const TextStyle(
                                      fontSize: 11.5,
                                      color: Color(0xFFB45309),
                                    ),
                                  ),
                                ],
                                const SizedBox(height: 12.0),
                                if (_canSelfReset)
                                  SizedBox(
                                    width: double.infinity,
                                    height: 42.0,
                                    child: ElevatedButton(
                                      onPressed: _isLoading ? null : _confirmResetToDefault,
                                      style: ElevatedButton.styleFrom(
                                        backgroundColor: const Color(0xFFF59E0B),
                                        foregroundColor: Colors.white,
                                        shape: RoundedRectangleBorder(
                                          borderRadius: BorderRadius.circular(10.0),
                                        ),
                                      ),
                                      child: Text(
                                        '重置为默认密码 $_resetDefaultPassword',
                                        style: const TextStyle(
                                          fontSize: 14.0,
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                    ),
                                  )
                                else
                                  const Text(
                                    '当前服务器不支持自助重置，请联系管理员在管理端为您处理。',
                                    style: TextStyle(
                                      fontSize: 11.5,
                                      color: Color(0xFFD97706),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 16.0),
                        ],

                        // Submit Button
                        SizedBox(
                          width: double.infinity,
                          height: 48.0,
                          child: ElevatedButton(
                            onPressed: _isLoading ? null : _submit,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.blue.shade700,
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8.0),
                              ),
                            ),
                            child: _isLoading
                                ? const CircularProgressIndicator(color: Colors.white)
                                : Text(
                                    _isRegister ? '立即注册并返回登录' : '立即登录',
                                    style: const TextStyle(fontSize: 16.0, fontWeight: FontWeight.bold),
                                  ),
                          ),
                        ),
                        const SizedBox(height: 16.0),

                        // Toggle Mode Link
                        TextButton(
                          onPressed: () {
                            setState(() {
                              // 换页签要清掉陈旧提示，否则「注册」页上还挂着
                              // 「密码需要重置」，用户会以为注册也出问题了
                              _dismissResetHint();
                              _isRegister = !_isRegister;
                            });
                          },
                          child: Text(
                            _isRegister ? '已有账号？去登录' : '没有账号？去注册',
                            style: TextStyle(color: Colors.blue.shade700),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
