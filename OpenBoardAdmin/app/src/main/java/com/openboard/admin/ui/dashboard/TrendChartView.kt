package com.openboard.admin.ui.dashboard

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.View
import com.openboard.admin.data.model.TimeseriesPoint

/**
 * 极简折线图。
 *
 * 为什么不用图表库：为本项目引一个几十上百 KB 的依赖只为画一条折线不划算，
 * 而且图表库通常自带一套主题/字体假设，跟现有界面风格对不上。
 * 这里 150 行 Canvas 代码就够了。
 *
 * 注意：这是"看趋势"用的，不是精确读数用的 —— 所以只画折线 + 网格，
 * 不给每个点标数值（几十个点标数字会糊成一片）。要精确数值看下面的列表。
 */
class TrendChartView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

    private var points: List<TimeseriesPoint> = emptyList()

    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#2563EB")
        style = Paint.Style.STROKE
        strokeWidth = dp(2f)
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#1A2563EB")
        style = Paint.Style.FILL
    }

    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#EEF0F3")
        strokeWidth = dp(1f)
    }

    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#2563EB")
        style = Paint.Style.FILL
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#9CA3AF")
        textSize = dp(10f)
    }

    /** 左右留白，给首尾日期文字留位置 */
    private val padLeft = dp(6f)
    private val padRight = dp(6f)
    private val padTop = dp(12f)
    private val padBottom = dp(24f)

    fun setData(data: List<TimeseriesPoint>) {
        points = data
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return

        val chartW = w - padLeft - padRight
        val chartH = h - padTop - padBottom
        if (chartW <= 0 || chartH <= 0) return

        // 三条水平网格线
        for (i in 0..2) {
            val y = padTop + chartH * i / 2f
            canvas.drawLine(padLeft, y, w - padRight, y, gridPaint)
        }

        if (points.isEmpty()) {
            canvas.drawText("暂无数据", padLeft + dp(4f), padTop + chartH / 2f, textPaint)
            return
        }

        val maxVal = points.maxOf { it.count }.coerceAtLeast(1)

        // 单点时画在中间，避免除零
        fun xAt(i: Int): Float =
            if (points.size == 1) padLeft + chartW / 2f
            else padLeft + chartW * i / (points.size - 1).toFloat()

        fun yAt(v: Int): Float = padTop + chartH * (1f - v.toFloat() / maxVal)

        // 折线路径 + 填充路径（填充让趋势更醒目）
        val line = Path()
        val fill = Path()
        points.forEachIndexed { i, p ->
            val x = xAt(i)
            val y = yAt(p.count)
            if (i == 0) {
                line.moveTo(x, y)
                fill.moveTo(x, padTop + chartH)
                fill.lineTo(x, y)
            } else {
                line.lineTo(x, y)
                fill.lineTo(x, y)
            }
        }
        fill.lineTo(xAt(points.size - 1), padTop + chartH)
        fill.close()

        canvas.drawPath(fill, fillPaint)
        canvas.drawPath(line, linePaint)

        // 数据点：点数少才画，多了会糊
        if (points.size <= 40) {
            points.forEachIndexed { i, p ->
                canvas.drawCircle(xAt(i), yAt(p.count), dp(1.8f), dotPaint)
            }
        }

        // 首尾日期
        canvas.drawText(shortDate(points.first().date), padLeft, h - dp(6f), textPaint)
        val lastLabel = shortDate(points.last().date)
        val lastW = textPaint.measureText(lastLabel)
        canvas.drawText(lastLabel, w - padRight - lastW, h - dp(6f), textPaint)

        // 峰值标注
        val peakLabel = "峰值 $maxVal"
        canvas.drawText(peakLabel, padLeft, padTop - dp(2f), textPaint)
    }

    /** 'YYYY-MM-DD' → 'M/D' */
    private fun shortDate(d: String): String {
        val parts = d.split('-')
        if (parts.size != 3) return d
        val m = parts[1].trimStart('0').ifEmpty { "0" }
        val day = parts[2].trimStart('0').ifEmpty { "0" }
        return "$m/$day"
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density
}
