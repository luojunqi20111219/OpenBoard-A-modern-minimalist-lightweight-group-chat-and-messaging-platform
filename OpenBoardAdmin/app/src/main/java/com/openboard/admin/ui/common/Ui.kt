package com.openboard.admin.ui.common

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.openboard.admin.R
import retrofit2.Response

/**
 * 管理端通用 UI 工具。
 *
 * 这些都是「写第三遍」的东西 —— 五个标签页里每个都要处理
 * loading / empty / error 三态，每个都要弹 toast、算圆形头像底色。
 * 抽出来放一处，改一次全都改到。
 */

private fun ctx(v: View): Context = v.context

// ---------------------------------------------------------------------------
// 圆形头像
// ---------------------------------------------------------------------------

/** 头像底色候选。按用户名哈希取，保证同一个人每次颜色一致 */
private val AVATAR_COLORS = intArrayOf(
    0xFF2563EB.toInt(), // blue
    0xFF7C3AED.toInt(), // violet
    0xFFDB2777.toInt(), // pink
    0xFFDC2626.toInt(), // red
    0xFFEA580C.toInt(), // orange
    0xFF15803D.toInt(), // green
    0xFF0891B2.toInt(), // cyan
    0xFF4F46E5.toInt(), // indigo
)

/**
 * 用用户名生成一个稳定的颜色下标。
 *
 * 不能用 hashCode()：Kotlin 的 String.hashCode 虽然稳定，但返回 int
 * 可能为负，取余后仍是负数，直接当数组下标会崩。这里先做绝对值，
 * 再对数组长度取模。
 */
private fun colorIndex(seed: String): Int {
    var h = 0
    for (ch in seed) h = (h * 31 + ch.code) and 0x7FFFFFFF
    return h % AVATAR_COLORS.size
}

/**
 * 把一个 TextView 渲染成圆形头像。
 *
 * 策略：TextView 永远保留「首字符 + 圆形底色」作为兜底外观；
 * 有网络头像时，用 Coil 把图片**裁成圆形**后设为该 TextView 的背景
 * （`ImageView`/`TextView` 都能吃 Drawable 背景），并把文字清空。
 * 加载失败时 Coil 不回调成功分支，首字符仍在，视觉上不会出现空白。
 *
 * 这样只需要一个 View，不用往父容器里插 ImageView，也就不会在
 * RecyclerView 复用行时插出一堆重复视图。
 */
fun bindAvatar(tv: TextView, url: String?, name: String) {
    val seed = name.ifBlank { "?" }
    val base = url?.takeIf { it.isNotBlank() }?.let { absolutize(it) }

    // 兜底外观先画上
    tv.text = initialOf(seed)
    tv.background = circleDrawable(AVATAR_COLORS[colorIndex(seed)])

    if (base == null) return

    val sizePx = if (tv.width > 0) tv.width else (48 * tv.resources.displayMetrics.density).toInt()

    coil.Coil.imageLoader(ctx(tv)).enqueue(
        coil.request.ImageRequest.Builder(ctx(tv))
            .data(base)
            .allowHardware(false) // 需要读回 Bitmap 做圆形遮罩，硬件位图不支持
            // 用自定义 Transformation 把方图裁成圆，作为背景贴上去
            .transformations(CoilRoundTransform(sizePx))
            .listener(
                onSuccess = { _, result ->
                    tv.background = result.drawable
                    tv.text = ""
                },
                onError = { _, _ ->
                    // 保留首字符兜底外观，不做任何事
                },
            )
            .build(),
    )
}

/**
 * Coil 的圆形裁剪 Transformation。
 *
 * 为什么自己写：coil-transformations 那个第三方库只为这一个功能引入
 * 一个依赖不划算，而圆裁逻辑本身只有十几行 —— 画一个圆心带圆角
 * 半径的 Path，用 SRC_IN 叠加即可。
 */
private class CoilRoundTransform(private val size: Int) :
    coil.transform.Transformation {

    override val cacheKey: String = "round_$size"

    override suspend fun transform(
        input: android.graphics.Bitmap,
        size: coil.size.Size,
    ): android.graphics.Bitmap {
        val side = minOf(input.width, input.height)
        val square = if (input.width == input.height) {
            input
        } else {
            // 先居中裁成正方形，否则圆会被拉扁
            val x = (input.width - side) / 2
            val y = (input.height - side) / 2
            android.graphics.Bitmap.createBitmap(input, x, y, side, side)
        }

        val output = android.graphics.Bitmap.createBitmap(
            square.width, square.height, android.graphics.Bitmap.Config.ARGB_8888,
        )
        val canvas = android.graphics.Canvas(output)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        val radius = square.width / 2f
        val path = android.graphics.Path().apply {
            addCircle(radius, radius, radius, android.graphics.Path.Direction.CW)
        }
        canvas.clipPath(path)
        canvas.drawBitmap(square, 0f, 0f, paint)

        if (square !== input) square.recycle()
        return output
    }
}

/** 取显示用首字符：中文取第一个字，英文取首字母大写 */
fun initialOf(name: String): String {
    val s = name.trim()
    if (s.isEmpty()) return "?"
    val first = s[0]
    return if (first.code in 0x4E00..0x9FFF) first.toString() else first.uppercaseChar().toString()
}

/** 圆形纯色背景 */
fun circleDrawable(color: Int): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(color)
}

// ---------------------------------------------------------------------------
// 三态视图容器
// ---------------------------------------------------------------------------

/**
 * 给列表页统一挂 loading / empty / error 三态。
 *
 * 用法：
 * ```
 * val state = StateView(container)
 * state.loading()
 * ...
 * state.content()
 * ```
 */
class StateView(private val host: LinearLayout) {

    private val loadingView: LinearLayout = LinearLayout(host.context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(0, dp(48), 0, dp(48))
        addView(android.widget.ProgressBar(context))
        addView(
            TextView(context).apply {
                text = "加载中…"
                setTextColor(ContextCompat.getColor(context, R.color.muted))
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, 0)
            },
        )
    }

    private val messageView: TextView = TextView(host.context).apply {
        gravity = Gravity.CENTER
        setPadding(dp(24), dp(48), dp(24), dp(48))
        textSize = 14f
        setTextColor(ContextCompat.getColor(context, R.color.muted))
        visibility = View.GONE
    }

    init {
        host.addView(loadingView)
        host.addView(messageView)
    }

    fun loading() {
        loadingView.visibility = View.VISIBLE
        messageView.visibility = View.GONE
    }

    /** 有内容 —— 三态全部隐藏，内容视图由调用方自己显示 */
    fun content() {
        loadingView.visibility = View.GONE
        messageView.visibility = View.GONE
    }

    fun empty(text: String) = message(text, R.color.muted)

    fun error(text: String) = message(text, R.color.danger)

    private fun message(text: String, colorRes: Int) {
        loadingView.visibility = View.GONE
        messageView.visibility = View.VISIBLE
        messageView.text = text
        messageView.setTextColor(ContextCompat.getColor(host.context, colorRes))
    }
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

fun View.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

fun View.visible(show: Boolean, gone: Boolean = true) {
    visibility = when {
        show -> View.VISIBLE
        gone -> View.GONE
        else -> View.INVISIBLE
    }
}

fun Context.toast(text: String) {
    Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
}

fun Context.toastLong(text: String) {
    Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}

/**
 * 把服务端返回的相对路径补成绝对 URL。
 *
 * 服务端存头像时写的是 `/api/download/xxx`，客户端的 baseUrl 可能指向
 * 另一台机器，直接丢给 Coil 会因为缺 host 而加载失败。
 */
fun absolutize(path: String): String {
    if (path.startsWith("http://") || path.startsWith("https://")) return path
    val base = com.openboard.admin.data.api.AdminRetrofitClient.getBaseUrl().trimEnd('/')
    return if (path.startsWith("/")) base + path else "$base/$path"
}

/**
 * 从 Retrofit 的失败响应里挖出服务端的 `detail` 文案。
 *
 * 服务端所有错误都返回 `{ detail: "..." }`，直接显示 HTTP 状态码
 * 对用户毫无意义。
 */
fun errorMessage(r: Response<*>): String {
    return try {
        val raw = r.errorBody()?.string()
        if (raw.isNullOrBlank()) return "请求失败（HTTP ${r.code()}）"
        val obj = com.google.gson.JsonParser.parseString(raw).asJsonObject
        obj.get("detail")?.asString
            ?: obj.get("msg")?.asString
            ?: "请求失败（HTTP ${r.code()}）"
    } catch (e: Exception) {
        "请求失败（HTTP ${r.code()}）"
    }
}

/** 相对时间：把 ISO 时间戳转成「3 分钟前」这种 */
fun humanTime(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    return try {
        val cleaned = iso.replace("T", " ").removeSuffix("Z")
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
        fmt.isLenient = true
        val t = fmt.parse(cleaned.substring(0, minOf(19, cleaned.length))) ?: return iso
        val diff = System.currentTimeMillis() - t.time
        when {
            diff < 60_000 -> "刚刚"
            diff < 3_600_000 -> "${diff / 60_000} 分钟前"
            diff < 86_400_000 -> "${diff / 3_600_000} 小时前"
            diff < 2_592_000_000L -> "${diff / 86_400_000} 天前"
            else -> cleaned.substring(0, minOf(10, cleaned.length))
        }
    } catch (e: Exception) {
        iso
    }
}

/** 角色标签文案 */
fun roleLabel(role: Int, isAdmin: Boolean): String = when {
    role == 2 -> "系统"
    isAdmin -> "管理员"
    else -> "普通用户"
}

fun roleColor(role: Int, isAdmin: Boolean): Int = when {
    role == 2 -> Color.parseColor("#6B7280")
    isAdmin -> Color.parseColor("#2563EB")
    else -> Color.parseColor("#8A9099")
}
