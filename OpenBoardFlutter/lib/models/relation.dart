class Relation {
  final int id;
  final String name;
  final String type; // "group" or "friend"
  final String? targetUser;
  final String? avatar;

  Relation({
    required this.id,
    required this.name,
    required this.type,
    this.targetUser,
    this.avatar,
  });

  factory Relation.fromJson(Map<String, dynamic> json) {
    return Relation(
      id: json['id'] ?? 0,
      name: json['name'] ?? '',
      type: json['type'] ?? 'friend',
      targetUser: json['targetUser'],
      avatar: json['avatar'],
    );
  }
}
