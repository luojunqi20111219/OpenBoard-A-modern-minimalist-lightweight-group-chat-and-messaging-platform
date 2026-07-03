package com.openboard.nativeapp.ui.main

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.DialogNotificationsBinding
import com.openboard.nativeapp.ui.adapter.NotificationAdapter
import kotlinx.coroutines.launch

/**
 * 系统公告/通知半屏抽屉页面，展示历史公告并在查看后自动标记为已读。
 */
class NotificationsBottomSheet(
    private val onAllMarkedRead: () -> Unit
) : BottomSheetDialogFragment() {
    private var _binding: DialogNotificationsBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: NotificationAdapter

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = DialogNotificationsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupUI()
        loadNotifications()
    }

    /**
     * 初始化 RecyclerView 与全部已读按钮事件
     */
    private fun setupUI() {
        adapter = NotificationAdapter()
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter

        binding.btnReadAll.setOnClickListener {
            markAllRead()
        }
    }

    /**
     * 异步拉取最新公告列表与最后已读 ID
     */
    private fun loadNotifications() {
        binding.progressBar.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE
        
        lifecycleScope.launch {
            val result = repository.getNotifications()
            binding.progressBar.visibility = View.GONE
            result.onSuccess { response ->
                val notices = response.data ?: emptyList()
                val lastRead = response.lastReadId ?: 0

                if (notices.isEmpty()) {
                    binding.tvEmpty.visibility = View.VISIBLE
                } else {
                    adapter.updateData(notices, lastRead)
                }
            }.onFailure { e ->
                Toast.makeText(
                    requireContext(),
                    "加载公告失败: ${e.message}",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    /**
     * 发送全部已读 API 请求并更新界面
     */
    private fun markAllRead() {
        lifecycleScope.launch {
            val result = repository.markNotificationsRead()
            result.onSuccess {
                Toast.makeText(requireContext(), "已全部标记已读", Toast.LENGTH_SHORT).show()
                onAllMarkedRead() // 通知外部隐藏红点
                loadNotifications() // 重新刷新以更新已读状态红点
            }.onFailure { e ->
                Toast.makeText(
                    requireContext(),
                    "操作失败: ${e.message}",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
