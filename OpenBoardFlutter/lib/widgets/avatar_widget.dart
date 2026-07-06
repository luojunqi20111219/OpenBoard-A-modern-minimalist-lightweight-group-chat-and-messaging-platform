import 'package:flutter/material.dart';
import '../services/api_service.dart';

class AvatarWidget extends StatelessWidget {
  final String name;
  final String nickname;
  final String? avatarUrl;
  final double size;
  final bool isOnline;
  final VoidCallback? onTap;

  const AvatarWidget({
    super.key,
    required this.name,
    required this.nickname,
    this.avatarUrl,
    this.size = 40.0,
    this.isOnline = false,
    this.onTap,
  });

  Color _getAvatarBgColor(String username) {
    if (username == 'filehelper') return const Color(0xFFE0F2F1);
    
    int hash = 0;
    for (int i = 0; i < username.length; i++) {
      hash = username.codeUnitAt(i) + ((hash << 5) - hash);
    }
    final colors = [
      const Color(0xFFFF5722),
      const Color(0xFF4CAF50),
      const Color(0xFF2196F3),
      const Color(0xFF9C27B0),
      const Color(0xFFE91E63),
      const Color(0xFFFF9800),
      const Color(0xFF009688),
      const Color(0xFF795548),
    ];
    int idx = hash.abs() % colors.length;
    return colors[idx];
  }

  @override
  Widget build(BuildContext context) {
    Widget avatarChild;
    final serverUrl = ApiService().serverUrl;

    if (name == 'filehelper') {
      avatarChild = Icon(
        Icons.folder,
        color: const Color(0xFF00796B),
        size: size * 0.5,
      );
    } else if (avatarUrl != null && avatarUrl!.trim().isNotEmpty) {
      String fullUrl = avatarUrl!;
      if (!fullUrl.startsWith('http') && !fullUrl.startsWith('data:image')) {
        fullUrl = '$serverUrl${fullUrl.startsWith('/') ? '' : '/'}$fullUrl';
      }
      
      avatarChild = ClipRRect(
        borderRadius: BorderRadius.circular(size / 2),
        child: Image.network(
          fullUrl,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (context, error, stackTrace) {
            return _buildTextAvatar();
          },
        ),
      );
    } else {
      avatarChild = _buildTextAvatar();
    }

    final avatarContainer = GestureDetector(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: name == 'filehelper' ? const Color(0xFFE0F2F1) : _getAvatarBgColor(name),
          shape: BoxShape.circle,
        ),
        child: Center(child: avatarChild),
      ),
    );

    if (isOnline && name != 'filehelper') {
      return Stack(
        children: [
          avatarContainer,
          Positioned(
            right: 0,
            bottom: 0,
            child: Container(
              width: size * 0.28,
              height: size * 0.28,
              decoration: BoxDecoration(
                color: Colors.green,
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: 2),
              ),
            ),
          )
        ],
      );
    }

    return avatarContainer;
  }

  Widget _buildTextAvatar() {
    final displayName = nickname.isNotEmpty ? nickname : (name.isNotEmpty ? name : 'U');
    final initial = displayName.substring(0, 1).toUpperCase();
    return Text(
      initial,
      style: TextStyle(
        color: Colors.white,
        fontWeight: FontWeight.bold,
        fontSize: size * 0.4,
      ),
    );
  }
}
