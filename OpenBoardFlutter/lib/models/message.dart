class Message {
  final int? id;
  final String name;
  final String nickname;
  final String content;
  final String time;
  final int roomId;
  final String? avatar;
  final bool isRecalled;

  Message({
    this.id,
    required this.name,
    required this.nickname,
    required this.content,
    required this.time,
    required this.roomId,
    this.avatar,
    this.isRecalled = false,
  });

  factory Message.fromJson(Map<String, dynamic> json) {
    return Message(
      id: json['id'],
      name: json['name'] ?? '',
      nickname: json['nickname'] ?? '',
      content: json['content'] ?? '',
      time: json['time'] ?? '',
      roomId: json['room_id'] ?? 0,
      avatar: json['avatar'],
      isRecalled: json['content'] == '[system_recalled]',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'nickname': nickname,
      'content': content,
      'time': time,
      'room_id': roomId,
      'avatar': avatar,
    };
  }
}
