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

  @override
  void initState() {
    super.initState();
    _serverController.text = ApiService().serverUrl;
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
          _showError(loginRes['message']);
          setState(() {
            _isLoading = false;
          });
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
                            hintText: 'http://47.93.6.111:5000',
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
