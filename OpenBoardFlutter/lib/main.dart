import 'package:flutter/material.dart';
import 'screens/login_screen.dart';
import 'screens/main_screen.dart';
import 'services/api_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // 1. Initialize the global ApiService
  final apiService = ApiService();
  await apiService.init();

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final token = ApiService().token;

    return MaterialApp(
      title: '信语 (OpenBoard) 移动端',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.blue,
          primary: Colors.blue.shade800,
          secondary: Colors.blueAccent,
        ),
        useMaterial3: true,
        fontFamily: 'Inter', // Sleek modern typography
      ),
      // If token is present, go straight to MainScreen, else go to LoginScreen
      home: token.isNotEmpty ? const MainScreen() : const LoginScreen(),
    );
  }
}
