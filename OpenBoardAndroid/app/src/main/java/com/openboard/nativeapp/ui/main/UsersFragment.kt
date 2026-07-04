package com.openboard.nativeapp.ui.main

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.FragmentListBinding
import com.openboard.nativeapp.ui.adapter.UserAdapter
import kotlinx.coroutines.launch
import androidx.appcompat.app.AlertDialog
import android.widget.EditText
import android.widget.FrameLayout

/**
 * 全站用户/联系人列表页面，展示全站活跃的私聊用户、黑名单标识与在线状态
 */
class UsersFragment : Fragment() {
    private var _binding: FragmentListBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: UserAdapter

    private val wsListener = object : WebSocketManager.WsListener {
        override fun onMessage(msg: WsMessage) {
            if (msg.type == "online_status") {
                val onlineList = msg.users ?: emptyList()
                activity?.runOnUiThread {
                    adapter.updateOnlineUsers(onlineList)
                }
            }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentListBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.toolbar.title = "我的好友"

        adapter = UserAdapter { user ->
            val nickname = user.nickname ?: user.username
            (activity as? MainActivity)?.navigateToChat(roomId = 0, roomName = nickname, targetUser = user.username)
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener { loadUsers() }
        
        binding.fab.visibility = View.VISIBLE
        binding.fab.setOnClickListener {
            val options = arrayOf("搜索并添加好友", "查看好友申请")
            AlertDialog.Builder(requireContext())
                .setTitle("好友管理")
                .setItems(options) { _, which ->
                    when (which) {
                        0 -> showAddFriendSearchDialog()
                        1 -> showPendingRequestsDialog()
                    }
                }
                .show()
        }

        WebSocketManager.addListener(wsListener)
        loadUsers()
    }

    private fun loadUsers() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            // First fetch blocklist to filter out
            val blockResult = repository.getUsersEnvelope()
            var blocked = emptyList<String>()
            blockResult.onSuccess { response ->
                blocked = response.blockedUsers ?: emptyList()
                adapter.updateBlockedUsers(blocked)
            }

            // Then fetch friends
            val result = repository.getFriends()
            binding.swipeRefresh.isRefreshing = false
            result.onSuccess { friends ->
                val me = SessionManager.username
                adapter.submitList(friends.filter { it.username != me && !blocked.contains(it.username) })
            }.onFailure {
                Toast.makeText(requireContext(), "加载好友列表失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showAddFriendSearchDialog() {
        val editText = EditText(requireContext()).apply {
            hint = "输入用户名或昵称"
        }
        val container = FrameLayout(requireContext()).apply {
            val params = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                leftMargin = 50
                rightMargin = 50
                topMargin = 20
                bottomMargin = 20
            }
            addView(editText, params)
        }

        AlertDialog.Builder(requireContext())
            .setTitle("搜索并添加好友")
            .setView(container)
            .setPositiveButton("搜索") { dialog, _ ->
                val query = editText.text.toString().trim()
                if (query.isNotEmpty()) {
                    searchAndSelectUser(query)
                }
                dialog.dismiss()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun searchAndSelectUser(query: String) {
        lifecycleScope.launch {
            val result = repository.searchUsers(query)
            result.onSuccess { users ->
                if (users.isEmpty()) {
                    Toast.makeText(requireContext(), "未找到匹配的用户", Toast.LENGTH_SHORT).show()
                    return@onSuccess
                }
                val displayNames = users.map { 
                    val name = it.nickname ?: it.username
                    val status = when {
                        it.isFriend == true -> " (已是好友)"
                        it.requestStatus == "pending" -> {
                            if (it.requestDirection == "sent") " (等待验证)" else " (对方已申请)"
                        }
                        else -> ""
                    }
                    "$name@${it.username}$status"
                }.toTypedArray()

                AlertDialog.Builder(requireContext())
                    .setTitle("选择要添加的用户")
                    .setItems(displayNames) { _, which ->
                        val target = users[which]
                        if (target.isFriend == true) {
                            Toast.makeText(requireContext(), "你们已经是好友了", Toast.LENGTH_SHORT).show()
                        } else if (target.requestStatus == "pending") {
                            if (target.requestDirection == "sent") {
                                Toast.makeText(requireContext(), "已发送过申请，请等待对方验证", Toast.LENGTH_SHORT).show()
                            } else {
                                // Direct respond
                                showRespondRequestDialog(target.username)
                            }
                        } else {
                            confirmSendRequest(target.username)
                        }
                    }
                    .show()
            }.onFailure {
                Toast.makeText(requireContext(), "搜索失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun confirmSendRequest(username: String) {
        AlertDialog.Builder(requireContext())
            .setTitle("发送好友申请")
            .setMessage("确定要添加 @$username 为好友吗？")
            .setPositiveButton("发送") { _, _ ->
                lifecycleScope.launch {
                    repository.sendFriendRequest(username)
                        .onSuccess {
                            Toast.makeText(requireContext(), "好友申请已发送", Toast.LENGTH_SHORT).show()
                        }
                        .onFailure { e ->
                            Toast.makeText(requireContext(), "发送失败: ${e.message}", Toast.LENGTH_SHORT).show()
                        }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showPendingRequestsDialog() {
        lifecycleScope.launch {
            val result = repository.getFriendRequests()
            result.onSuccess { requests ->
                if (requests.isEmpty()) {
                    Toast.makeText(requireContext(), "暂无好友申请", Toast.LENGTH_SHORT).show()
                    return@onSuccess
                }
                
                val displayNames = requests.map { 
                    val name = it.nickname ?: it.fromUser
                    "$name (@${it.fromUser})"
                }.toTypedArray()

                AlertDialog.Builder(requireContext())
                    .setTitle("待处理的好友申请")
                    .setItems(displayNames) { _, which ->
                        val request = requests[which]
                        showRespondRequestDialog(request.fromUser)
                    }
                    .show()
            }.onFailure {
                Toast.makeText(requireContext(), "获取好友申请列表失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showRespondRequestDialog(fromUser: String) {
        AlertDialog.Builder(requireContext())
            .setTitle("处理好友申请")
            .setMessage("是否同意来自 @$fromUser 的好友申请？")
            .setPositiveButton("同意") { _, _ ->
                respondRequest(fromUser, "accept")
            }
            .setNegativeButton("拒绝") { _, _ ->
                respondRequest(fromUser, "reject")
            }
            .setNeutralButton("取消", null)
            .show()
    }

    private fun respondRequest(fromUser: String, action: String) {
        lifecycleScope.launch {
            repository.respondFriendRequest(fromUser, action)
                .onSuccess {
                    Toast.makeText(requireContext(), if (action == "accept") "已同意好友申请" else "已拒绝好友申请", Toast.LENGTH_SHORT).show()
                    loadUsers() // Reload friend list
                }
                .onFailure { e ->
                    Toast.makeText(requireContext(), "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        WebSocketManager.removeListener(wsListener)
        _binding = null
    }
}
