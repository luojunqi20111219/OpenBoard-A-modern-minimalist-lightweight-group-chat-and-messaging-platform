package com.openboard.nativeapp.ui.common

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 服务端时间统一渲染工具。
 *
 * ## 背景（这个文件存在的唯一理由）
 * 服务端（Cloudflare Workers + D1）里存的时间一律是 **UTC**，出参形如
 * `2026-10-05 06:14:55Z`（末尾的 Z 标明这是 UTC，不是本地时间）。
 *
 * 历史上客户端的做法是 `iso.removeSuffix("Z")` 然后直接丢给 SimpleDateFormat 解析。
 * removeSuffix 把唯一的时区标记抹掉了，SimpleDateFormat 又**默认按本机时区**解析，
 * 于是这串 UTC 被当成了北京时间 —— 中国用户（UTC+8）看到的每条时间都**早了 8 小时**。
 *
 * 正确做法：**先按 UTC 解析成绝对时间戳**，再按本机时区格式化输出。
 * 绝对时间戳是全球唯一的，不存在歧义，之后想怎么显示都行。
 *
 * ## 注意
 * 任何地方都不要再出现 `removeSuffix("Z")`。那是这个 bug 的根源。
 * 若服务端将来不下发 Z（裸 UTC 串，如 `2026-10-05 06:14:55`），本文件也会
 * **主动按 UTC 解析**，保证同一份数据无论带不带 Z 都得到相同结果。
 */
object Time {

    /** 服务端可能下发的几种格式。带时区标记的用 XXX，不带的交给 forceUtc 处理 */
    private val PATTERN_ISO_ZONE = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"
    private val PATTERN_ISO_ZONE_NO_MS = "yyyy-MM-dd'T'HH:mm:ssXXX"

    /**
     * 把一个服务端时间串解析成绝对毫秒时间戳（epoch millis）。
     *
     * 解析规则：
     * - 末尾有 `Z` / `±HH:MM` → 按该时区解析（交给 SimpleDateFormat 自己认）
     * - 没有时区标记 → **按 UTC 解析**（关键：不能按本机时区，否则又会偏）
     * - 纯日期 `YYYY-MM-DD` → 按 UTC 当天 00:00 解析
     * - 认不出的格式 → 返回 null（调用方决定怎么兜底，不要抛异常）
     *
     * @return epoch millis，解析失败返回 null
     */
    fun parseServerTime(value: String?): Long? {
        if (value.isNullOrBlank()) return null
        val raw = value.trim()

        // 带时区标记：交给 SimpleDateFormat 的 XXX 处理
        val hasZone = Regex("[Zz]$").containsMatchIn(raw) ||
            Regex("[+-]\\d{2}:?\\d{2}$").containsMatchIn(raw)

        val normalized = raw.replace(' ', 'T')

        if (hasZone) {
            val patterns = listOf(PATTERN_ISO_ZONE, PATTERN_ISO_ZONE_NO_MS)
            for (p in patterns) {
                tryParse(normalized, p, forceUtc = false)?.let { return it }
            }
            // 兜底：有些服务端下发的是 `2026-10-05T06:14:55Z`（没有毫秒）
            tryParse(normalized, "yyyy-MM-dd'T'HH:mm:ss'Z'", forceUtc = false)?.let { return it }
            tryParse(normalized, "yyyy-MM-dd'T'HH:mm:ssXXX", forceUtc = false)?.let { return it }
            return null
        }

        // 无时区标记 → 强制按 UTC 解析。这就是修复 8 小时偏差的那一行
        val bare = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS",
            "yyyy-MM-dd'T'HH:mm:ss",
            "yyyy-MM-dd HH:mm:ss",
            "yyyy-MM-dd",
            "yyyy-MM-dd'T'HH:mm"
        )
        for (p in bare) {
            tryParse(normalized, p, forceUtc = true)?.let { return it }
        }
        return null
    }

    private fun tryParse(input: String, pattern: String, forceUtc: Boolean): Long? {
        return try {
            val fmt = SimpleDateFormat(pattern, Locale.US)
            fmt.isLenient = false
            if (forceUtc) fmt.timeZone = TimeZone.getTimeZone("UTC")
            // setLenient(false) 下，格式不匹配会抛 ParseException，这里吞掉试下一个
            fmt.parse(input)?.time
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 相对时间：「刚刚」「3 分钟前」「2 小时前」「5 天前」，超过 30 天转绝对日期。
     * 解析失败原样返回，不抛异常、不吞掉内容。
     */
    fun friendlyTime(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val ms = parseServerTime(value) ?: return value
        val diff = System.currentTimeMillis() - ms
        return when {
            diff < 0 -> "刚刚"                 // 服务端时钟略快，不做「-3 分钟前」这种鬼东西
            diff < 60_000L -> "刚刚"
            diff < 3_600_000L -> "${diff / 60_000} 分钟前"
            diff < 86_400_000L -> "${diff / 3_600_000} 小时前"
            diff < 30L * 86_400_000L -> "${diff / 86_400_000} 天前"
            else -> absoluteDate(ms)
        }
    }

    /**
     * 聊天气泡 / 通知里的时间展示。按「今天 / 昨天 / 今年 / 更早」四档降级。
     * 解析失败原样返回。
     */
    fun displayTime(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val ms = parseServerTime(value) ?: return value

        val now = Calendar.getInstance()
        val then = Calendar.getInstance().apply { timeInMillis = ms }

        val sameDay = now.get(Calendar.YEAR) == then.get(Calendar.YEAR) &&
            now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)
        if (sameDay) {
            return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
        }

        val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
        val isYesterday = yesterday.get(Calendar.YEAR) == then.get(Calendar.YEAR) &&
            yesterday.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)
        if (isYesterday) {
            return "昨天 " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
        }

        if (now.get(Calendar.YEAR) == then.get(Calendar.YEAR)) {
            return SimpleDateFormat("M月d日 HH:mm", Locale.getDefault()).format(Date(ms))
        }
        return SimpleDateFormat("yyyy年M月d日 HH:mm", Locale.getDefault()).format(Date(ms))
    }

    /** 会话列表右侧的短时间：今天只给 HH:mm，再早给「昨天」/「M月d日」/「yyyy/M/d」 */
    fun shortTime(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val ms = parseServerTime(value) ?: return value

        val now = Calendar.getInstance()
        val then = Calendar.getInstance().apply { timeInMillis = ms }

        val sameDay = now.get(Calendar.YEAR) == then.get(Calendar.YEAR) &&
            now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)
        if (sameDay) {
            return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
        }

        val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
        val isYesterday = yesterday.get(Calendar.YEAR) == then.get(Calendar.YEAR) &&
            yesterday.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)
        if (isYesterday) return "昨天"

        if (now.get(Calendar.YEAR) == then.get(Calendar.YEAR)) {
            return SimpleDateFormat("M月d日", Locale.getDefault()).format(Date(ms))
        }
        return SimpleDateFormat("yyyy/M/d", Locale.getDefault()).format(Date(ms))
    }

    /** 绝对日期：2026年10月5日。解析失败原样返回 */
    fun absoluteDate(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val ms = parseServerTime(value) ?: return value
        return absoluteDate(ms)
    }

    /** 绝对日期重载：直接吃毫秒时间戳 */
    fun absoluteDate(ms: Long): String =
        SimpleDateFormat("yyyy年M月d日", Locale.getDefault()).format(Date(ms))

    /** 绝对日期时间：2026年10月5日 14:15。解析失败原样返回 */
    fun absoluteDateTime(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val ms = parseServerTime(value) ?: return value
        return SimpleDateFormat("yyyy年M月d日 HH:mm", Locale.getDefault()).format(Date(ms))
    }
}
