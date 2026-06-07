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
 * 系统公告 BottomSheet 弹窗
 */
class NotificationsBottomSheet(
    private val onAllReadCallback: () -> Unit
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

        adapter = NotificationAdapter()
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter

        binding.btnReadAll.setOnClickListener {
            markAllRead()
        }

        loadNotifications()
    }

    private fun loadNotifications() {
        binding.progressBar.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE
        lifecycleScope.launch {
            val result = repository.getNotifications()
            binding.progressBar.visibility = View.GONE
            result.onSuccess { response ->
                val list = response.data ?: emptyList()
                val lastReadId = response.lastReadId ?: 0
                if (list.isEmpty()) {
                    binding.tvEmpty.visibility = View.VISIBLE
                } else {
                    binding.tvEmpty.visibility = View.GONE
                    adapter.updateData(list, lastReadId)
                }
            }.onFailure { e ->
                Toast.makeText(requireContext(), "获取公告失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun markAllRead() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.markNotificationsRead()
            binding.progressBar.visibility = View.GONE
            result.onSuccess {
                Toast.makeText(requireContext(), "已全部标记已读", Toast.LENGTH_SHORT).show()
                onAllReadCallback.invoke()
                // Refresh list
                loadNotifications()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
