import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/message.dart';
import '../services/api_service.dart';
import 'avatar_widget.dart';

class ChatBubble extends StatelessWidget {
  final Message message;
  final bool isSelf;
  final bool isOnline;
  final VoidCallback? onLongPress;

  const ChatBubble({
    super.key,
    required this.message,
    required this.isSelf,
    this.isOnline = false,
    this.onLongPress,
  });

  void _launchUrl(String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (message.content == '[system_recalled]') {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 16.0),
        alignment: Alignment.center,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 6.0),
          decoration: BoxDecoration(
            color: Colors.grey.shade200,
            borderRadius: BorderRadius.circular(12.0),
          ),
          child: Text(
            isSelf ? '您撤回了一条消息' : '"${message.nickname}" 撤回了一条消息',
            style: TextStyle(
              fontSize: 12.0,
              color: Colors.grey.shade600,
              fontStyle: FontStyle.italic,
            ),
          ),
        ),
      );
    }

    final serverUrl = ApiService().serverUrl;
    final isImg = message.content.startsWith('[img:') && message.content.endsWith(']');
    final isFile = message.content.startsWith('[file:') && message.content.endsWith(']');
    final isCard = message.content.startsWith('[user_card:') && message.content.endsWith(']');

    Widget contentWidget;

    if (isImg) {
      String imgUrl = message.content.substring(5, message.content.length - 1);
      if (!imgUrl.startsWith('http') && !imgUrl.startsWith('data:image')) {
        imgUrl = '$serverUrl${imgUrl.startsWith('/') ? '' : '/'}$imgUrl';
      }
      contentWidget = ClipRRect(
        borderRadius: BorderRadius.circular(8.0),
        child: Image.network(
          imgUrl,
          width: 200,
          fit: BoxFit.contain,
          loadingBuilder: (context, child, loadingProgress) {
            if (loadingProgress == null) return child;
            return const SizedBox(
              width: 100,
              height: 100,
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            );
          },
          errorBuilder: (context, error, stackTrace) {
            return const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.broken_image, color: Colors.grey),
                SizedBox(width: 8),
                Text('图片加载失败', style: TextStyle(color: Colors.grey)),
              ],
            );
          },
        ),
      );
    } else if (isCard) {
      final raw = message.content.substring(11, message.content.length - 1);
      final parts = raw.split(':');
      final cardUsername = parts.isNotEmpty ? parts[0] : '';
      final cardNickname = parts.length > 1 ? Uri.decodeComponent(parts[1]) : '';
      final cardAvatar = parts.length > 2 ? Uri.decodeComponent(parts[2]) : '';

      final isMyOwnCard = cardUsername == ApiService().currentUsername;

      contentWidget = Container(
        width: 220,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12.0),
          border: Border.all(color: Colors.grey.shade300, width: 1.0),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.05),
              blurRadius: 4,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        padding: const EdgeInsets.all(12.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                AvatarWidget(
                  name: cardUsername,
                  nickname: cardNickname,
                  avatarUrl: cardAvatar,
                  size: 40.0,
                ),
                const SizedBox(width: 10.0),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        cardNickname.isNotEmpty ? cardNickname : cardUsername,
                        style: const TextStyle(
                          fontSize: 14.0,
                          fontWeight: FontWeight.bold,
                          color: Colors.black87,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2.0),
                      Text(
                        '@$cardUsername',
                        style: TextStyle(
                          fontSize: 11.0,
                          color: Colors.grey.shade600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const Divider(height: 16.0, thickness: 0.5),
            SizedBox(
              width: double.infinity,
              height: 32.0,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: isMyOwnCard ? Colors.grey.shade200 : Colors.blue.shade600,
                  foregroundColor: isMyOwnCard ? Colors.grey.shade700 : Colors.white,
                  elevation: 0,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6.0),
                  ),
                  padding: EdgeInsets.zero,
                ),
                onPressed: isMyOwnCard
                    ? null
                    : () async {
                        final success = await ApiService().addFriendDirectly(cardUsername);
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(success ? '已成功添加该好友' : '添加好友失败'),
                              duration: const Duration(seconds: 2),
                            ),
                          );
                        }
                      },
                child: Text(
                  isMyOwnCard ? '我的名片' : '添加好友',
                  style: const TextStyle(
                    fontSize: 12.0,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    } else if (isFile) {
      final raw = message.content.substring(6, message.content.length - 1);
      final pipeIdx = raw.indexOf('|');
      final fileUrl = pipeIdx != -1 ? raw.substring(0, pipeIdx) : raw;
      final filename = pipeIdx != -1 ? raw.substring(pipeIdx + 1) : raw.substring(raw.lastIndexOf('/') + 1);
      final fullUrl = fileUrl.startsWith('http') ? fileUrl : '$serverUrl${fileUrl.startsWith('/') ? '' : '/'}$fileUrl';

      contentWidget = InkWell(
        onTap: () => _launchUrl(fullUrl),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.insert_drive_file,
              color: isSelf ? Colors.white : Colors.blue.shade700,
              size: 32.0,
            ),
            const SizedBox(width: 8.0),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    filename,
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 14.0,
                      color: isSelf ? Colors.white : Colors.black87,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2.0),
                  Text(
                    '点击下载此附件',
                    style: TextStyle(
                      fontSize: 11.0,
                      color: isSelf ? Colors.white70 : Colors.grey.shade600,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    } else {
      contentWidget = Text(
        message.content,
        style: TextStyle(
          fontSize: 14.0,
          color: isSelf ? Colors.white : Colors.black87,
        ),
      );
    }

    final bubbleBgColor = isSelf
        ? (isCard ? Colors.transparent : Colors.blue.shade600)
        : (isFile || isImg || isCard ? Colors.transparent : Colors.grey.shade100);

    return Padding(
      key: ValueKey(message.id ?? UniqueKey()),
      padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 6.0),
      child: Row(
        mainAxisAlignment: isSelf ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isSelf) ...[
            AvatarWidget(
              name: message.name,
              nickname: message.nickname,
              avatarUrl: message.avatar,
              isOnline: isOnline,
              size: 38.0,
            ),
            const SizedBox(width: 8.0),
          ],
          Flexible(
            child: Column(
              crossAxisAlignment: isSelf ? CrossAxisAlignment.end : CrossAxisAlignment.start,
              children: [
                if (!isSelf)
                  Padding(
                    padding: const EdgeInsets.only(left: 4.0, bottom: 2.0),
                    child: Text(
                      '${message.nickname} (@${message.name})',
                      style: TextStyle(fontSize: 11.0, color: Colors.grey.shade600),
                    ),
                  ),
                GestureDetector(
                  onLongPress: onLongPress,
                  child: Container(
                    padding: isImg || isCard
                        ? EdgeInsets.zero
                        : const EdgeInsets.symmetric(horizontal: 12.0, vertical: 10.0),
                    decoration: BoxDecoration(
                      color: bubbleBgColor,
                      border: !isSelf && !isImg && !isFile && !isCard
                          ? Border.all(color: Colors.grey.shade200, width: 1.0)
                          : null,
                      borderRadius: BorderRadius.only(
                        topLeft: const Radius.circular(12.0),
                        topRight: const Radius.circular(12.0),
                        bottomLeft: Radius.circular(isSelf ? 12.0 : 2.0),
                        bottomRight: Radius.circular(isSelf ? 2.0 : 12.0),
                      ),
                    ),
                    child: contentWidget,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 2.0, left: 4.0, right: 4.0),
                  child: Text(
                    message.time,
                    style: TextStyle(fontSize: 10.0, color: Colors.grey.shade500),
                  ),
                ),
              ],
            ),
          ),
          if (isSelf) ...[
            const SizedBox(width: 8.0),
            AvatarWidget(
              name: message.name,
              nickname: message.nickname,
              avatarUrl: message.avatar,
              isOnline: false,
              size: 38.0,
            ),
          ],
        ],
      ),
    );
  }
}
