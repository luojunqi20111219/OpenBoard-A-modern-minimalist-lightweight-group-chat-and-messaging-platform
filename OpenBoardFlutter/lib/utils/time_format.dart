/// 服务端时间统一渲染工具。
///
/// ## 背景（这个文件存在的唯一理由）
/// 服务端（Cloudflare Workers + D1）里存的时间一律是 **UTC**，出参形如
/// `2026-10-05 06:14:55Z`（末尾的 Z 标明这是 UTC，不是本地时间）。
///
/// Dart 里有个坑：`DateTime.parse('2026-10-05 06:14:55')` 得到的是 **本地时间**
/// （isUtc == false），而 `DateTime.parse('2026-10-05 06:14:55Z')` 得到 UTC。
/// 一旦直接 `DateTime.parse(serverTime).hour` 拿去显示，中国用户（UTC+8）
/// 看到的每条时间都会**早 8 小时**。
///
/// 正确做法：**先解析成 UTC 的绝对时刻，再 `.toLocal()` 输出**。
library time_format;

/// 把服务端时间串解析成**本机时区的** DateTime。
///
/// 解析规则：
/// - 末尾有 `Z` / `±HH:MM` → DateTime.parse 自己就能认出时区
/// - 没有时区标记 → **强制按 UTC 解析**（关键：不能按本地解析，否则又会偏）
/// - 纯日期 `YYYY-MM-DD` → 按 UTC 当天 00:00 解析
/// - 认不出的格式 → 返回 null，调用方决定怎么兜底
DateTime? parseServerTime(String? value) {
  if (value == null) return null;
  final raw = value.trim();
  if (raw.isEmpty) return null;

  // 统一分隔符：Dart 的 DateTime.parse 吃不了 '2006-01-02 15:04:05' 这种带空格的，
  // 但能吃 'T' 分隔的 ISO 形式
  final iso = raw.replaceFirst(' ', 'T');

  final hasZone = RegExp(r'[Zz]$').hasMatch(iso) ||
      RegExp(r'[+-]\d{2}:?\d{2}$').hasMatch(iso);

  try {
    if (hasZone) {
      return DateTime.parse(iso).toLocal();
    }
    // 无时区标记 → 这是 UTC，显式标出来。就是这一行修掉 8 小时偏差
    return DateTime.parse('${iso}Z').toLocal();
  } catch (_) {
    // 纯日期 YYYY-MM-DD 之类的兜底
    try {
      final d = DateTime.parse(iso);
      return hasZone ? d.toLocal() : DateTime.utc(d.year, d.month, d.day).toLocal();
    } catch (_) {
      return null;
    }
  }
}

String _two(int n) => n.toString().padLeft(2, '0');

/// 相对时间：「刚刚」「3 分钟前」「2 小时前」「5 天前」，超过 30 天转绝对日期。
/// 解析失败原样返回，不吞掉内容。
String friendlyTime(String? value) {
  if (value == null || value.trim().isEmpty) return '';
  final t = parseServerTime(value);
  if (t == null) return value;

  final diff = DateTime.now().difference(t);
  if (diff.isNegative || diff.inSeconds < 60) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays < 30) return '${diff.inDays} 天前';
  return absoluteDate(t);
}

/// 聊天气泡 / 通知里的时间展示。按「今天 / 昨天 / 今年 / 更早」四档降级。
/// 解析失败原样返回。
String displayTime(String? value) {
  if (value == null || value.trim().isEmpty) return '';
  final t = parseServerTime(value);
  if (t == null) return value;

  final now = DateTime.now();
  final hhmm = '${_two(t.hour)}:${_two(t.minute)}';

  if (now.year == t.year && now.month == t.month && now.day == t.day) {
    return hhmm;
  }

  final yesterday = now.subtract(const Duration(days: 1));
  if (yesterday.year == t.year &&
      yesterday.month == t.month &&
      yesterday.day == t.day) {
    return '昨天 $hhmm';
  }

  if (now.year == t.year) {
    return '${t.month}月${t.day}日 $hhmm';
  }
  return '${t.year}年${t.month}月${t.day}日 $hhmm';
}

/// 会话列表右侧的短时间：今天只给 HH:mm，再早给「昨天」/「M月d日」/「yyyy/M/d」
String shortTime(String? value) {
  if (value == null || value.trim().isEmpty) return '';
  final t = parseServerTime(value);
  if (t == null) return value;

  final now = DateTime.now();
  if (now.year == t.year && now.month == t.month && now.day == t.day) {
    return '${_two(t.hour)}:${_two(t.minute)}';
  }

  final yesterday = now.subtract(const Duration(days: 1));
  if (yesterday.year == t.year &&
      yesterday.month == t.month &&
      yesterday.day == t.day) {
    return '昨天';
  }

  if (now.year == t.year) return '${t.month}月${t.day}日';
  return '${t.year}/${t.month}/${t.day}';
}

/// 绝对日期：2026年10月5日。解析失败原样返回
String absoluteDate(Object? value) {
  final t = value is DateTime ? value : parseServerTime(value as String?);
  if (t == null) return value is String ? value : '';
  return '${t.year}年${t.month}月${t.day}日';
}

/// 绝对日期时间：2026年10月5日 14:15。解析失败原样返回
String absoluteDateTime(String? value) {
  if (value == null || value.trim().isEmpty) return '';
  final t = parseServerTime(value);
  if (t == null) return value;
  return '${t.year}年${t.month}月${t.day}日 ${_two(t.hour)}:${_two(t.minute)}';
}
