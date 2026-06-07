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
import com.openboard.nativeapp.data.model.User
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.FragmentListBinding
import com.openboard.nativeapp.ui.adapter.UserAdapter
import kotlinx.coroutines.launch

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
        binding.toolbar.title = "用户列表"
        binding.toolbar.setNavigationOnClickListener {
            (activity as? MainActivity)?.loadFragment(ChatListFragment())
        }

        adapter = UserAdapter { user ->
            val nickname = user.nickname ?: user.username
            (activity as? MainActivity)?.navigateToChat(roomId = 0, roomName = nickname, targetUser = user.username)
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener { loadUsers() }
        
        WebSocketManager.addListener(wsListener)
        loadUsers()
    }

    private fun loadUsers() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val result = repository.getUsers()
            binding.swipeRefresh.isRefreshing = false
            result.onSuccess { users ->
                val me = SessionManager.username
                adapter.submitList(users.filter { it.username != me })
            }.onFailure {
                Toast.makeText(requireContext(), "加载用户列表失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        WebSocketManager.removeListener(wsListener)
        _binding = null
    }
}
