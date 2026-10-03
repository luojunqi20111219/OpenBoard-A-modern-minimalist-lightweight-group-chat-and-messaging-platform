package com.openboard.admin.ui.dashboard

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.StatsOverviewResponse
import com.openboard.admin.databinding.FragmentDashboardBinding
import com.openboard.admin.ui.common.StateView
import com.openboard.admin.ui.common.Views
import com.openboard.admin.ui.common.errorMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 「数据看板」标签页。
 *
 * ---------------------------------------------------------------------------
 * 一些口径上的说明（都会在界面上如实呈现，不粉饰）
 * ---------------------------------------------------------------------------
 *   · 「今日」按 UTC 计 —— 与数据库里的存储口径一致。看板上不换算本地时区，
 *     否则会和服务端的 GROUP BY 对不上（曲线整体偏移几小时）。
 *   · 「禁言」只统计**当前仍生效**的禁言。已过期的不算，否则这个数字
 *     只增不减，看着像有一堆人在被禁言。
 *   · 「新增群聊」曲线从迁移生效后才开始有数据。历史群由迁移统一补了
 *     一个近似时间戳，所以起点会有个尖峰 —— 页面底部有提示说明。
 */
class DashboardFragment : Fragment() {

    private var _binding: FragmentDashboardBinding? = null
    private val binding get() = _binding!!

    private lateinit var stateView: StateView

    private companion object {
        val METRICS = listOf("消息量", "新增用户", "新增群聊")
        val METRIC_VALUES = listOf("messages", "users", "groups")
        val DAYS = listOf("7 天", "30 天", "90 天")
        val DAY_VALUES = listOf(7, 30, 90)
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentDashboardBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        stateView = StateView(binding.stateHost)

        binding.spMetric.adapter = ArrayAdapter(
            requireContext(), android.R.layout.simple_spinner_dropdown_item, METRICS,
        )
        binding.spDays.adapter = ArrayAdapter(
            requireContext(), android.R.layout.simple_spinner_dropdown_item, DAYS,
        )
        binding.spDays.setSelection(1) // 默认 30 天

        val listener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                loadChart()
            }
            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }
        binding.spMetric.onItemSelectedListener = listener
        binding.spDays.onItemSelectedListener = listener

        binding.swipe.setOnRefreshListener { load() }

        load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private fun load() {
        stateView.loading()
        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().statsOverview().execute()
                } catch (e: Exception) {
                    null
                }
            }

            val b = _binding ?: return@launch
            b.swipe.isRefreshing = false

            if (resp == null) {
                stateView.error("网络错误，请检查服务器地址与网络")
                return@launch
            }
            if (!resp.isSuccessful) {
                stateView.error(errorMessage(resp))
                return@launch
            }

            bind(resp.body() ?: StatsOverviewResponse())
            stateView.content()
            loadChart()
        }
    }

    private fun bind(s: StatsOverviewResponse) {
        val b = _binding ?: return
        val ctx = requireContext()

        // 每次重建，避免重复叠加
        fun fill(host: LinearLayout, value: String, label: String) {
            host.removeAllViews()
            host.addView(Views.statCell(ctx, value, label))
        }

        fill(b.cellTodayUsers, s.newUsersToday.toString(), "新增用户")
        fill(b.cellTodayMessages, s.newMessagesToday.toString(), "新增消息")
        fill(b.cellTodayGroups, s.newGroupsToday.toString(), "新增群聊")

        fill(b.cellOnline, s.online.toString(), "在线")
        fill(b.cellUsers, s.users.toString(), "用户")
        fill(b.cellGroups, s.groups.toString(), "群聊")
        fill(b.cellMessages, s.messages.toString(), "消息")

        fill(b.cellBanned, s.banned.toString(), "封禁中")
        fill(b.cellMuted, s.muted.toString(), "禁言中")
        fill(b.cellAdmins, s.admins.toString(), "管理员")
    }

    private fun loadChart() {
        val b = _binding ?: return
        val metricIdx = b.spMetric.selectedItemPosition.coerceIn(0, METRIC_VALUES.size - 1)
        val daysIdx = b.spDays.selectedItemPosition.coerceIn(0, DAY_VALUES.size - 1)
        val metric = METRIC_VALUES[metricIdx]
        val days = DAY_VALUES[daysIdx]

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().statsTimeseries(metric, days).execute()
                } catch (e: Exception) {
                    null
                }
            }

            val bb = _binding ?: return@launch
            val points = resp?.body()?.points
            if (resp == null || !resp.isSuccessful || points == null) {
                bb.chart.setData(emptyList())
                bb.tvChartSummary.text = "趋势数据加载失败"
                return@launch
            }

            bb.chart.setData(points)

            val sum = points.sumOf { it.count }
            val peak = points.maxOfOrNull { it.count } ?: 0
            val peakDay = points.firstOrNull { it.count == peak }?.date ?: "-"
            bb.tvChartSummary.text = buildString {
                append("近 $days 天合计 $sum")
                if (peak > 0) append("　·　峰值 $peak（$peakDay）")
            }

            // 群聊新增曲线的数据是从迁移生效后才有的 —— 必须说明，
            // 否则起点那个尖峰会让人以为"某天突然建了一堆群"
            bb.tvChartNote.visibility = if (metric == "groups") View.VISIBLE else View.GONE
            if (metric == "groups") {
                bb.tvChartNote.text =
                    "说明：群聊创建时间是从数据库迁移生效后才开始记录的。" +
                        "迁移时给已有群补了一个近似时间戳，所以曲线起点可能偏高，" +
                        "之后的数值才是真实新增。"
            }
        }
    }
}
