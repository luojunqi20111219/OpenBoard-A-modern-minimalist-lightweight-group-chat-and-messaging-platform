package com.openboard.admin.ui.common

import android.app.DatePickerDialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.AuditLogItem
import com.openboard.admin.databinding.FragmentAuditBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Calendar
import java.util.Locale

/**
 * 「操作记录」标签页 —— 谁在什么时候做了什么。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要筛选和分页
 * ---------------------------------------------------------------------------
 * 这个页面现在合并了两处审计：
 *   · admin_audit_logs —— 全局管理操作（提权、封禁、撤回、禁言…）
 *   · group_audit_logs —— 群内管理操作（踢人、群内禁言…）
 *
 * 合并的代价是记录量成倍增长。原来只有一个 limit=200 的裸列表，
 * 实际用起来就是"想找上周谁把某人提权了，得一路往下翻"。所以补上
 * 操作者 / 动作 / 时间区间 / 来源四个筛选 + offset 分页。
 *
 * 时间区间只传日期（'YYYY-MM-DD'）即可 —— 服务端会补全 00:00:00 与
 * 23:59:59。客户端不补，否则"截止到今天"会把今天的记录全部漏掉。
 */
class AuditFragment : Fragment() {

    private var _binding: FragmentAuditBinding? = null
    private val binding get() = _binding!!

    private lateinit var stateView: StateView
    private val adapter = AuditAdapter()

    /** 已加载的全部记录（分页累加） */
    private val loaded = mutableListOf<AuditLogItem>()

    /** 服务端报告的总条数 —— 用来判断"还有没有下一页" */
    private var total = 0

    private var loading = false

    companion object {
        private const val PAGE_SIZE = 50
        private val SOURCES = listOf("全部来源", "全局操作", "群内操作")
        private val SOURCE_VALUES = listOf("all", "admin", "group")
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentAuditBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        stateView = StateView(binding.stateHost)
        binding.recycler.layoutManager = LinearLayoutManager(requireContext())
        binding.recycler.adapter = adapter
        binding.swipe.setOnRefreshListener { load(reset = true, silent = true) }

        // 来源下拉
        binding.spSource.adapter = ArrayAdapter(
            requireContext(),
            android.R.layout.simple_spinner_dropdown_item,
            SOURCES,
        )

        // 日期选择：点一下弹日历，不手敲（手敲格式错误率太高）
        binding.etFrom.setOnClickListener { pickDate(binding.etFrom) }
        binding.etTo.setOnClickListener { pickDate(binding.etTo) }

        binding.btnQuery.setOnClickListener { load(reset = true) }
        binding.btnClear.setOnClickListener {
            binding.etActor.setText("")
            binding.etAction.setText("")
            binding.etFrom.setText("")
            binding.etTo.setText("")
            binding.spSource.setSelection(0)
            load(reset = true)
        }
        binding.btnMore.setOnClickListener { loadMore() }

        load(reset = true)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    /** 弹日期选择器；选完写回输入框 */
    private fun pickDate(target: android.widget.EditText) {
        val cal = Calendar.getInstance()
        DatePickerDialog(
            requireContext(),
            { _, y, m, d ->
                target.setText(String.format(Locale.US, "%04d-%02d-%02d", y, m + 1, d))
            },
            cal.get(Calendar.YEAR),
            cal.get(Calendar.MONTH),
            cal.get(Calendar.DAY_OF_MONTH),
        ).show()
    }

    private fun load(reset: Boolean, silent: Boolean = false) {
        if (!silent && reset) stateView.loading()
        loadInternal(offset = 0, reset = true)
    }

    private fun loadMore() {
        if (loading) return
        loadInternal(offset = loaded.size, reset = false)
    }

    private fun loadInternal(offset: Int, reset: Boolean) {
        if (loading) return
        loading = true
        val b = _binding ?: run { loading = false; return }

        val actor = b.etActor.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val action = b.etAction.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val from = b.etFrom.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val to = b.etTo.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val sourceIdx = b.spSource.selectedItemPosition.coerceIn(0, SOURCE_VALUES.size - 1)
        val source = SOURCE_VALUES[sourceIdx]

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().auditLogs(
                        actor = actor,
                        action = action,
                        from = from,
                        to = to,
                        source = source,
                        limit = PAGE_SIZE,
                        offset = offset,
                    ).execute()
                } catch (e: Exception) {
                    null
                }
            }

            val bb = _binding ?: run { loading = false; return@launch }
            bb.swipe.isRefreshing = false
            loading = false

            if (resp == null) {
                if (reset) stateView.error("网络错误，请检查服务器地址与网络")
                return@launch
            }
            if (!resp.isSuccessful) {
                if (reset) stateView.error(errorMessage(resp))
                return@launch
            }

            val body = resp.body()
            val page = body?.logs ?: emptyList()
            total = body?.total ?: page.size

            if (reset) {
                loaded.clear()
            }
            // 服务端按 uid 去重（uid 是 source:id 拼的），客户端再兜一层：
            // 合并两表后 id 会重复，如果按 id 去重会误删真实记录
            val seen = loaded.map { it.stableKey }.toMutableSet()
            for (item in page) {
                if (seen.add(item.stableKey)) loaded.add(item)
            }

            adapter.submitList(loaded.toList())

            bb.tvAuditCount.visibility = View.VISIBLE
            bb.tvAuditCount.text = if (loaded.isEmpty()) {
                "没有匹配的记录"
            } else {
                "已显示 ${loaded.size} / $total 条"
            }

            if (loaded.isEmpty()) {
                stateView.empty("没有匹配的操作记录\n换个筛选条件试试，或清空筛选")
                bb.recycler.visibility = View.GONE
                bb.btnMore.visibility = View.GONE
            } else {
                stateView.content()
                bb.recycler.visibility = View.VISIBLE
                bb.btnMore.visibility = if (loaded.size < total) View.VISIBLE else View.GONE
            }
        }
    }
}
