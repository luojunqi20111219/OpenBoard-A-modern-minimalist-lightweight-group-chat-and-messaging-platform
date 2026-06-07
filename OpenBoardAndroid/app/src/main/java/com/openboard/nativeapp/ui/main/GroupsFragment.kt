package com.openboard.nativeapp.ui.main

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.DialogCreateGroupBinding
import com.openboard.nativeapp.databinding.FragmentListBinding
import com.openboard.nativeapp.ui.adapter.GroupAdapter
import kotlinx.coroutines.launch

/**
 * 群组列表页面，展示所有公开及已加入的群聊频道，并支持创建新群聊。
 */
class GroupsFragment : Fragment() {
    private var _binding: FragmentListBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: GroupAdapter

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentListBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupUI()
        loadGroups()
    }

    /**
     * 初始化界面组件、工具栏、适配器与事件监听器
     */
    private fun setupUI() {
        // 设置标题及返回按钮
        binding.toolbar.title = "群组列表"
        binding.toolbar.setNavigationOnClickListener {
            (activity as? MainActivity)?.loadFragment(ChatListFragment())
        }

        // 显示浮动操作按钮（用于创建群聊）
        binding.fab.visibility = View.VISIBLE
        binding.fab.setOnClickListener {
            showCreateGroupDialog()
        }

        // 初始化 RecyclerView
        adapter = GroupAdapter { group ->
            // 点击群组跳转至聊天室，传递 room_id、群名称与群主ID
            (activity as? MainActivity)?.navigateToChat(
                roomId = group.id,
                roomName = group.name,
                ownerId = group.ownerId
            )
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter

        // 下拉刷新事件监听
        binding.swipeRefresh.setOnRefreshListener {
            loadGroups()
        }
    }

    /**
     * 从后端 API 异步加载可查看的群组列表
     */
    private fun loadGroups() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val result = repository.getGroups()
            binding.swipeRefresh.isRefreshing = false
            result.onSuccess { groups ->
                adapter.submitList(groups)
            }.onFailure { e ->
                Toast.makeText(
                    requireContext(),
                    "获取群组列表失败: ${e.message}",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    /**
     * 弹出创建群聊的输入对话框
     */
    private fun showCreateGroupDialog() {
        val dialogBinding = DialogCreateGroupBinding.inflate(layoutInflater)
        AlertDialog.Builder(requireContext())
            .setTitle("创建新群聊")
            .setView(dialogBinding.root)
            .setPositiveButton("创建") { dialog, _ ->
                val groupName = dialogBinding.etGroupName.text.toString().trim()
                val groupDesc = dialogBinding.etGroupDesc.text.toString().trim()
                if (groupName.isEmpty()) {
                    Toast.makeText(requireContext(), "群聊名称不能为空", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                createGroup(groupName, groupDesc)
                dialog.dismiss()
            }
            .setNegativeButton("取消") { dialog, _ ->
                dialog.dismiss()
            }
            .show()
    }

    /**
     * 异步发起创建群组的 API 请求
     */
    private fun createGroup(name: String, description: String?) {
        lifecycleScope.launch {
            val result = repository.createGroup(name, description)
            result.onSuccess { group ->
                Toast.makeText(requireContext(), "群组创建成功", Toast.LENGTH_SHORT).show()
                loadGroups() // 刷新列表
                
                // 自动进入新创建 the 群聊
                (activity as? MainActivity)?.navigateToChat(
                    roomId = group.id,
                    roomName = group.name,
                    ownerId = group.ownerId
                )
            }.onFailure { e ->
                Toast.makeText(
                    requireContext(),
                    "创建群组失败: ${e.message}",
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
