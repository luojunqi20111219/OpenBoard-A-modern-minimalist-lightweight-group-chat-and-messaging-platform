package com.openboard.nativeapp.ui.main

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.FragmentChatListBinding
import com.openboard.nativeapp.ui.adapter.ConversationAdapter
import kotlinx.coroutines.launch

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
        setupBottomNav()
        loadData()
    }

    override fun onStart() {
        super.onStart()
        (activity as? MainActivity)?.recentChatsListener = wsListener
        loadConversations()
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
                targetUser = conv.targetUser
            )
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter
    }

    private fun setupBottomNav() {
        binding.btnUsers.setOnClickListener {
            (activity as? MainActivity)?.loadUsersList()
        }
        binding.btnGroups.setOnClickListener {
            (activity as? MainActivity)?.loadGroupsList()
        }
        binding.btnProfile.setOnClickListener {
            (activity as? MainActivity)?.loadFragment(ProfileFragment())
        }
    }

    private fun loadConversations() {
        val list = SessionManager.getConversations()
        adapter.submitList(ArrayList(list))
        binding.tvGroupCount.text = "最近会话: ${list.size}"
    }

    private fun loadData() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val groupsResult = repository.getGroups()
            val usersResult = repository.getUsers()
            binding.progressBar.visibility = View.GONE

            groupsResult.onSuccess { groups ->
                // Pre-populate any room information if needed
            }
            usersResult.onSuccess { users ->
                // Pre-populate any user profiles if needed
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
