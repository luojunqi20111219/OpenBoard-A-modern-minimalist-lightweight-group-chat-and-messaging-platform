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
import com.openboard.nativeapp.data.model.Group
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.DialogCreateGroupBinding
import com.openboard.nativeapp.databinding.FragmentListBinding
import com.openboard.nativeapp.ui.adapter.GroupAdapter
import kotlinx.coroutines.launch

class GroupsFragment : Fragment() {
    private var _binding: FragmentListBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: GroupAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentListBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.toolbar.title = "群组列表"
        binding.toolbar.setNavigationOnClickListener {
            (activity as? MainActivity)?.loadFragment(ChatListFragment())
        }
        binding.fab.visibility = View.VISIBLE
        binding.fab.setOnClickListener { showCreateGroupDialog() }

        adapter = GroupAdapter { group ->
            (activity as? MainActivity)?.navigateToChat(
                roomId = group.id,
                roomName = group.name,
                ownerId = group.ownerId
            )
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener { loadGroups() }
        loadGroups()
    }

    private fun loadGroups() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val result = repository.getGroups()
            binding.swipeRefresh.isRefreshing = false
            result.onSuccess { groups ->
                adapter.submitList(groups)
            }.onFailure {
                Toast.makeText(requireContext(), "加载群组失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showCreateGroupDialog() {
        val dialogBinding = DialogCreateGroupBinding.inflate(layoutInflater)
        AlertDialog.Builder(requireContext())
            .setTitle("创建群组")
            .setView(dialogBinding.root)
            .setPositiveButton("创建") { _, _ ->
                val name = dialogBinding.etGroupName.text.toString().trim()
                val desc = dialogBinding.etGroupDesc.text.toString().trim()
                if (name.isNotEmpty()) {
                    createGroup(name, desc.ifEmpty { null })
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun createGroup(name: String, description: String?) {
        lifecycleScope.launch {
            val result = repository.createGroup(name, description)
            result.onSuccess {
                Toast.makeText(requireContext(), "群组创建成功！", Toast.LENGTH_SHORT).show()
                loadGroups()
            }.onFailure {
                Toast.makeText(requireContext(), "创建群组失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
