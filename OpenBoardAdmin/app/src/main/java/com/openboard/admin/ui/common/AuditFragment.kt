package com.openboard.admin.ui.common

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.databinding.FragmentAuditBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 「操作记录」标签页 —— 谁在什么时候做了什么。
 *
 * 这张表是管理体系的底线保障：动态授权意味着任何人拿到管理权限后
 * 都能继续授权别人，如果没有留痕，出了问题根本无从追查。
 *
 * 所有写操作（申请、批准、撤销、重置密码、封禁、删除）都会落到
 * admin_audit_logs。审计写入失败不阻断主流程（见 admin-grants.ts 的
 * audit()），所以这里是"尽力而为"的记录，不是严格的事务日志。
 */
class AuditFragment : Fragment() {

    private var _binding: FragmentAuditBinding? = null
    private val binding get() = _binding!!

    private lateinit var stateView: StateView
    private val adapter = AuditAdapter()

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
        binding.swipe.setOnRefreshListener { load(silent = true) }

        load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private fun load(silent: Boolean = false) {
        if (!silent) stateView.loading()

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().auditLogs(200).execute()
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

            val logs = resp.body()?.logs ?: emptyList()
            adapter.submitList(logs)

            if (logs.isEmpty()) {
                stateView.empty("暂无操作记录\n（数据库可能尚未完成管理员功能初始化）")
                b.recycler.visibility = View.GONE
            } else {
                stateView.content()
                b.recycler.visibility = View.VISIBLE
            }
        }
    }
}
