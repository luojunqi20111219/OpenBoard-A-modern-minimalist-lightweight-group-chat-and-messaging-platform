package com.openboard.nativeapp.ui.main

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.FragmentChatListBinding
import com.openboard.nativeapp.ui.adapter.ConversationAdapter
import kotlinx.coroutines.launch

/**
 * 消息会话主页面，展示最近聊天的群组/个人会话及通知未读小红点
 */
class ChatListFragment : Fragment() {
    private var _binding: FragmentChatListBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: ConversationAdapter

    private val wsListener = object : MainActivity.WsMessageListener {
        override fun onWsMessageReceived(msg: WsMessage) {
            if (msg.type == "online_status") {
                val onlineList = msg.users ?: emptyList()
                adapter.updateOnlineUsers(onlineList)
                binding.tvUserCount.text = "在线: ${onlineList.size}"
            } else {
                loadConversations()
            }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentChatListBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupRecyclerView()
        
        binding.btnNotifications.setOnClickListener {
            val sheet = NotificationsBottomSheet {
                binding.noticeBadge.visibility = View.GONE
            }
            sheet.show(childFragmentManager, "Notifications")
        }

        binding.fabNewChat.setOnClickListener {
            (activity as? MainActivity)?.loadUsersList()
        }
        
        loadData()
    }

    override fun onStart() {
        super.onStart()
        (activity as? MainActivity)?.recentChatsListener = wsListener
        loadConversations()
        checkNotifications()
    }

    override fun onStop() {
        super.onStop()
        (activity as? MainActivity)?.recentChatsListener = null
    }

    private fun setupRecyclerView() {
        adapter = ConversationAdapter { conv ->
            SessionManager.clearUnread(conv.id, conv.targetUser)
            (activity as? MainActivity)?.navigateToChat(
                roomId = conv.id,
                roomName = conv.name,
                targetUser = conv.targetUser,
                ownerId = conv.ownerId
            )
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter
    }



    private fun loadConversations() {
        val blockedList = SessionManager.blockedUsers
        val list = SessionManager.getConversations().filter {
            it.targetUser == null || !blockedList.contains(it.targetUser)
        }
        adapter.submitList(ArrayList(list))
        binding.tvGroupCount.text = "最近会话: ${list.size}"
    }

    private fun loadData() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val groupsResult = repository.getGroups()
            val usersResult = repository.getUsers()
            binding.progressBar.visibility = View.GONE

            groupsResult.onSuccess {
                // 可以按需在这里缓存
            }
            usersResult.onSuccess {
                // 可以按需在这里缓存
            }
        }
    }

    private fun checkNotifications() {
        lifecycleScope.launch {
            val result = repository.getNotifications()
            result.onSuccess { response ->
                val list = response.data ?: emptyList()
                val lastReadId = response.lastReadId ?: 0
                val hasUnread = list.any { it.id > lastReadId }
                if (hasUnread) {
                    binding.noticeBadge.visibility = View.VISIBLE
                } else {
                    binding.noticeBadge.visibility = View.GONE
                }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
