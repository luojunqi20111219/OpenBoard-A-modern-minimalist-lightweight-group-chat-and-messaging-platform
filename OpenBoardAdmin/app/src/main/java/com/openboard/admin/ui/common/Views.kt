package com.openboard.admin.ui.common

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 代码里造小 UI 组件的工厂。
 *
 * 为什么不全用 XML：这些碎片组件（标签、统计格、行）长得几乎一样，
 * 但数量多、变体多（有的带颜色有的不带），写 XML 要建十几个近乎重复
 * 的布局文件，还要为每个写一个 <include>。在代码里拼反而更清楚，
 * 改样式也就改一处。
 */
object Views {

    /** 带背景色的圆角小标签，如「管理员」「已封禁」 */
    fun chip(
        ctx: Context,
        text: String,
        textColor: Int,
        bgColor: Int,
        textSizeSp: Float = 11f,
    ): TextView = TextView(ctx).apply {
        this.text = text
        setTextColor(textColor)
        textSize = textSizeSp
        setPadding(dp(ctx, 8), dp(ctx, 3), dp(ctx, 8), dp(ctx, 3))
        background = GradientDrawable().apply {
            cornerRadius = dp(ctx, 9).toFloat()
            setColor(withAlpha(bgColor, 0.12f))
        }
    }

    /** 一个可点击的文本行（用于抽屉/设置列表） */
    fun settingRow(ctx: Context, title: String, subtitle: String? = null): LinearLayout =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(ctx, 14), 0, dp(ctx, 14))

            addView(
                TextView(ctx).apply {
                    text = title
                    textSize = 15f
                    setTextColor(Color.parseColor("#111827"))
                },
            )
            if (!subtitle.isNullOrBlank()) {
                addView(
                    TextView(ctx).apply {
                        text = subtitle
                        textSize = 12.5f
                        setTextColor(ContextCompat.getColor(ctx, com.openboard.admin.R.color.muted))
                        setPadding(0, dp(ctx, 3), 0, 0)
                    },
                )
            }
        }

    /** 统计格子：大数字 + 小标题，横向排开用 */
    fun statCell(ctx: Context, value: String, label: String): LinearLayout =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)

            addView(
                TextView(ctx).apply {
                    text = value
                    textSize = 21f
                    setTextColor(ContextCompat.getColor(ctx, com.openboard.admin.R.color.brand))
                    gravity = Gravity.CENTER
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                },
            )
            addView(
                TextView(ctx).apply {
                    text = label
                    textSize = 11.5f
                    setTextColor(ContextCompat.getColor(ctx, com.openboard.admin.R.color.muted))
                    gravity = Gravity.CENTER
                    setPadding(0, dp(ctx, 3), 0, 0)
                },
            )
        }

    /** 一条「左标题 —— 右内容」的信息行 */
    fun infoRow(ctx: Context, label: String, value: String, valueColor: Int? = null): LinearLayout =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(ctx, 8), 0, dp(ctx, 8))

            addView(
                TextView(ctx).apply {
                    text = label
                    textSize = 13.5f
                    setTextColor(ContextCompat.getColor(ctx, com.openboard.admin.R.color.muted))
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                },
            )
            addView(
                TextView(ctx).apply {
                    text = value
                    textSize = 13.5f
                    gravity = Gravity.END
                    setTextColor(valueColor ?: Color.parseColor("#111827"))
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    )
                },
            )
        }

    /** 1dp 分隔线 */
    fun divider(ctx: Context): android.view.View = android.view.View(ctx).apply {
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(ctx, 1),
        )
        setBackgroundColor(Color.parseColor("#EFEFEF"))
    }

    /** 区块标题 */
    fun sectionTitle(ctx: Context, text: String): TextView = TextView(ctx).apply {
        this.text = text
        textSize = 12.5f
        setTextColor(ContextCompat.getColor(ctx, com.openboard.admin.R.color.muted))
        setPadding(0, dp(ctx, 16), 0, dp(ctx, 6))
    }

    fun dp(ctx: Context, v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), ctx.resources.displayMetrics).toInt()

    /** 给颜色加透明度 —— 用于 chip 的浅底 */
    private fun withAlpha(color: Int, alpha: Float): Int =
        Color.argb((255 * alpha).toInt(), Color.red(color), Color.green(color), Color.blue(color))
}
