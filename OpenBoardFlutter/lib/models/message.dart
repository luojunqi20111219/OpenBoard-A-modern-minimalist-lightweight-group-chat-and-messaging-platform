class Message {
  final int? id;
  final String name;
  final String nickname;
  final String content;
  final String time;
  final int roomId;
  final String? avatar;
  final bool isRecalled;
  final bool canRecall;
  final bool canEdit;
  final bool edited;
  final int readCount;
  final String? clientId;
  final String? receiver;
  final String? deliveryStatus;

  Message({
    this.id,
    required this.name,
    required this.nickname,
    required this.content,
    required this.time,
    required this.roomId,
    this.avatar,
    this.isRecalled = false,
    this.canRecall = false,
    this.canEdit = false,
    this.edited = false,
    this.readCount = 0,
    this.clientId,
    this.receiver,
    this.deliveryStatus,
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
      canRecall: json['can_recall'] == true || json['can_recall'] == 1,
      canEdit: json['can_edit'] == true || json['can_edit'] == 1,
      edited: json['edited'] == true || json['edited_at'] != null,
      readCount: json['read_count'] ?? 0,
      clientId: json['client_id'],
      receiver: json['receiver'],
      deliveryStatus: json['delivery_status'],
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
      'can_recall': canRecall,
      'can_edit': canEdit,
      'edited': edited,
      'read_count': readCount,
      'client_id': clientId,
      'receiver': receiver,
      'delivery_status': deliveryStatus,
    };
  }

  Message copyWith({
    int? id,
    String? content,
    String? time,
    bool? edited,
    int? readCount,
    String? deliveryStatus,
  }) {
    return Message(
      id: id ?? this.id,
      name: name,
      nickname: nickname,
      content: content ?? this.content,
      time: time ?? this.time,
      roomId: roomId,
      avatar: avatar,
      isRecalled: isRecalled,
      canRecall: canRecall,
      canEdit: canEdit,
      edited: edited ?? this.edited,
      readCount: readCount ?? this.readCount,
      clientId: clientId,
      receiver: receiver,
      deliveryStatus: deliveryStatus ?? this.deliveryStatus,
    );
  }
}
