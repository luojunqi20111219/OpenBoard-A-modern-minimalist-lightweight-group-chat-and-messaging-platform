package com.openboard.admin.ui.auth

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.tabs.TabLayout
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.AdminRequestItem
import com.openboard.admin.databinding.FragmentAdminRequestsBinding
import com.openboard.admin.ui.common.StateView
import com.openboard.admin.ui.common.errorMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 「授权」标签页。
 *
 * 这是用户明确要求的能力：同意谁成为管理员。
 *
 * 流程设计成「申请 → 批准」而不是管理员直接在用户列表点一下就提权：
 * 管理端用户列表里有几十个人，误点一下就把陌生人变成管理员是很大的
 * 风险。让申请人自己提交申请（带说明、设备信息、时间），管理员在
 * 有完整上下文的情况下做决定，而且这是个显式动作。
 *
 * 三个子标签：待处理 / 已批准 / 已拒绝。
 */
class AdminRequestsFragment : Fragment() {

    private var _binding: FragmentAdminRequestsBinding? = null
    private val binding get() = _binding!!

    private lateinit var stateView: StateView
    private lateinit var adapter: AdminRequestAdapter

    private var currentStatus = "pending"
    private val statuses = listOf("pending", "approved", "rejected")
    private val titles = listOf("待处理", "已批准", "已拒绝")

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentAdminRequestsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        stateView = StateView(binding.stateHost)

        adapter = AdminRequestAdapter(
            onApprove = { confirmApprove(it) },
            onReject = { confirmReject(it) },
        )
        binding.recycler.layoutManager = LinearLayoutManager(requireContext())
        binding.recycler.adapter = adapter

        for (t in titles) binding.subTabs.addTab(binding.subTabs.newTab().setText(t))
        binding.subTabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                currentStatus = statuses.getOrElse(tab.position) { "pending" }
                load()
            }
            override fun onTabUnselected(tab: TabLayout.Tab) = Unit
            override fun onTabReselected(tab: TabLayout.Tab) { load(silent = true) }
        })

        binding.swipe.setOnRefreshListener { load(silent = true) }
        load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    /** 供外部（概览页「去处理」）刷新 */
    fun refresh() {
        if (_binding != null) load(silent = true)
    }

    private fun load(silent: Boolean = false) {
        if (!silent) stateView.loading()

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().listRequests(currentStatus).execute()
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

            val list = resp.body()?.requests ?: emptyList()
            adapter.submitList(list)

            // 服务端在表未迁移时会返回 200 + 空列表 + detail，这里把 detail 显示出来，
            // 否则用户会以为是"没人申请"
            val detail = resp.body()?.detail
            if (list.isEmpty()) {
                if (!detail.isNullOrBlank()) {
                    stateView.error("读取失败：$detail")
                } else {
                    stateView.empty(
                        when (currentStatus) {
                            "pending" -> "目前没有待处理的申请"
                            "approved" -> "还没有批准过任何人"
                            else -> "没有已拒绝的记录"
                        },
                    )
                }
                b.recycler.visibility = View.GONE
            } else {
                stateView.content()
                b.recycler.visibility = View.VISIBLE
            }
        }
    }

    // -----------------------------------------------------------------------
    // 批准 / 拒绝
    // -----------------------------------------------------------------------

    private fun confirmApprove(item: AdminRequestItem) {
        AlertDialog.Builder(requireContext())
            .setTitle("批准 ${item.username} 成为管理员")
            .setMessage(
                "批准后 TA 可以：\n" +
                    "· 登录管理端 App\n" +
                    "· 封禁 / 解封任意用户\n" +
                    "· 重置他人密码\n" +
                    "· 继续授予或撤销其他人的管理权限\n\n" +
                    "只在确认对方身份可信时才批准。",
            )
            .setPositiveButton("批准") { _, _ -> doAction("批准", item, approve = true) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmReject(item: AdminRequestItem) {
        AlertDialog.Builder(requireContext())
            .setTitle("拒绝 ${item.username} 的申请")
            .setMessage("对方不会收到通知，之后可以重新提交申请。")
            .setPositiveButton("拒绝") { _, _ -> doAction("拒绝", item, approve = false) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doAction(label: String, item: AdminRequestItem, approve: Boolean) {
        lifecycleScope.launch {
            val err = withContext(Dispatchers.IO) {
                try {
                    // 传 request_id 而不是 username —— 列表里可能有多条历史记录，
                    // 用 id 能确保操作的就是用户点的那一条
                    val body = mapOf<String, Any>(
                        "username" to item.username,
                        "request_id" to item.id,
                    )
                    val r = if (approve) {
                        AdminRetrofitClient.api().approveAdmin(body).execute()
                    } else {
                        AdminRetrofitClient.api().rejectAdmin(body).execute()
                    }
                    if (r.isSuccessful) null else errorMessage(r)
                } catch (e: Exception) {
                    "网络错误：${e.message}"
                }
            }
            val ctx = context ?: return@launch
            if (err == null) {
                Toast.makeText(
                    ctx,
                    if (approve) "已授予 ${item.username} 管理权限" else "已拒绝该申请",
                    Toast.LENGTH_SHORT,
                ).show()
                load(silent = true)
            } else {
                Toast.makeText(ctx, "$label 失败：$err", Toast.LENGTH_LONG).show()
            }
        }
    }
}
