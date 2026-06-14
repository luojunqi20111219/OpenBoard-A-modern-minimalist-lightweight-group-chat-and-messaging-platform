package com.openboard.nativeapp.ui.theme

import android.content.Context
import android.graphics.Color
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.ImageButton
import androidx.annotation.ColorInt
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.floatingactionbutton.FloatingActionButton

/**
 * 全局主题管理器：持久化用户选择的主色调与聊天背景色，并提供运行时应用工具函数
 */
object ThemeManager {

    private const val PREFS = "theme_prefs"
    private const val KEY_PRIMARY = "primary_color"
    private const val KEY_CHAT_BG = "chat_bg_color"
    private const val KEY_CHAT_BG_TYPE = "chat_bg_type"
    private const val KEY_CUSTOM_BG_PATH = "custom_bg_path"

    // ─── 预设主色调 ───────────────────────────────────────────
    val PRIMARY_COLORS = listOf(
        0xFF5C6BC0.toInt(), // 靛蓝（默认）
        0xFF039BE5.toInt(), // 天蓝
        0xFF00897B.toInt(), // 青绿
        0xFF43A047.toInt(), // 森绿
        0xFFF4511E.toInt(), // 橙色
        0xFFE91E63.toInt(), // 玫瑰
        0xFF8E24AA.toInt(), // 紫色
        0xFFD32F2F.toInt(), // 深红
        0xFFF9A825.toInt(), // 金色
        0xFF546E7A.toInt(), // 炭灰
    )

    val PRIMARY_NAMES = listOf(
        "靛蓝", "天蓝", "青绿", "森绿", "橙色",
        "玫瑰", "紫色", "深红", "金色", "炭灰"
    )

    // ─── 预设聊天背景 ──────────────────────────────────────────
    val CHAT_BG_COLORS = listOf(
        0xFFE8ECF4.toInt(), // 浅蓝灰（默认）
        0xFFFFFFFF.toInt(), // 纯白
        0xFFE8F5E9.toInt(), // 浅绿
        0xFFEDE7F6.toInt(), // 浅紫
        0xFFFFF9C4.toInt(), // 淡黄
        0xFFDCE8FF.toInt(), // 浅蓝
        0xFFFFE0E0.toInt(), // 浅粉
        0xFFE0F7FA.toInt(), // 薄荷
    )

    val CHAT_BG_NAMES = listOf(
        "蓝灰", "纯白", "浅绿", "浅紫", "淡黄", "浅蓝", "浅粉", "薄荷"
    )

    // ─── 读写接口 ──────────────────────────────────────────────
    fun getPrimaryColor(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY_PRIMARY, PRIMARY_COLORS[0])

    fun setPrimaryColor(context: Context, @ColorInt color: Int) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(KEY_PRIMARY, color).apply()

    fun getChatBackground(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY_CHAT_BG, CHAT_BG_COLORS[0])

    fun setChatBackground(context: Context, @ColorInt color: Int) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(KEY_CHAT_BG, color).apply()

    fun isCustomBackground(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CHAT_BG_TYPE, "preset") == "custom"

    fun setCustomBackground(context: Context, path: String?) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CHAT_BG_TYPE, if (path != null) "custom" else "preset")
            .putString(KEY_CUSTOM_BG_PATH, path)
            .apply()

    fun getCustomBackgroundPath(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CUSTOM_BG_PATH, null)

    fun applyChatBackground(context: Context, view: View) {
        if (isCustomBackground(context)) {
            val path = getCustomBackgroundPath(context)
            if (path != null) {
                try {
                    val bitmap = BitmapFactory.decodeFile(path)
                    if (bitmap != null) {
                        view.background = BitmapDrawable(context.resources, bitmap)
                        return
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
        view.background = null
        view.setBackgroundColor(getChatBackground(context))
    }

    // ─── 工具函数 ──────────────────────────────────────────────
    /** 将颜色加深 factor 倍，用于深色变体 */
    fun darken(@ColorInt color: Int, factor: Float = 0.75f): Int {
        val r = (Color.red(color) * factor).toInt().coerceIn(0, 255)
        val g = (Color.green(color) * factor).toInt().coerceIn(0, 255)
        val b = (Color.blue(color) * factor).toInt().coerceIn(0, 255)
        return Color.argb(255, r, g, b)
    }

    /** 生成渐变 Drawable（用于 Toolbar / Header 背景） */
    fun buildGradientDrawable(context: Context): GradientDrawable {
        val primary = getPrimaryColor(context)
        return GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(primary, darken(primary))
        ).apply { gradientType = GradientDrawable.LINEAR_GRADIENT }
    }

    /** 构建纯色气泡背景 Drawable（带圆角） */
    fun buildBubbleSelf(context: Context): GradientDrawable {
        val primary = getPrimaryColor(context)
        return GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(primary, darken(primary))
        ).apply {
            gradientType = GradientDrawable.LINEAR_GRADIENT
            cornerRadii = floatArrayOf(18f, 18f, 18f, 18f, 18f, 18f, 4f, 4f)
        }
    }

    /** 将主题颜色应用到目标 View 背景（用于 Toolbar） */
    fun applyToHeader(context: Context, vararg views: View) {
        val d = buildGradientDrawable(context)
        views.forEach { it.background = d }
    }

    /** 将主题颜色应用到 FAB */
    fun applyToFab(context: Context, fab: FloatingActionButton) {
        val primary = getPrimaryColor(context)
        fab.backgroundTintList = android.content.res.ColorStateList.valueOf(primary)
    }

    /** 将主题颜色应用到 BottomNavigationView 选中项 */
    fun applyToBottomNav(context: Context, nav: BottomNavigationView) {
        val primary = getPrimaryColor(context)
        val unselected = 0xFFB0BAC8.toInt()
        val states = arrayOf(
            intArrayOf(android.R.attr.state_checked),
            intArrayOf(-android.R.attr.state_checked)
        )
        val colors = intArrayOf(primary, unselected)
        val csl = android.content.res.ColorStateList(states, colors)
        nav.itemIconTintList = csl
        nav.itemTextColor = csl
    }

    /** 将主题颜色应用到 ImageButton（图标着色） */
    fun applyTintToButtons(context: Context, vararg buttons: ImageButton) {
        val primary = getPrimaryColor(context)
        buttons.forEach {
            it.setColorFilter(primary, android.graphics.PorterDuff.Mode.SRC_IN)
        }
    }

    /** 将发送按钮背景改为主题渐变 */
    fun applyToSendButton(context: Context, button: ImageButton) {
        val primary = getPrimaryColor(context)
        val d = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(primary, darken(primary))
        ).apply {
            gradientType = GradientDrawable.LINEAR_GRADIENT
            shape = GradientDrawable.OVAL
        }
        button.background = d
    }
}
