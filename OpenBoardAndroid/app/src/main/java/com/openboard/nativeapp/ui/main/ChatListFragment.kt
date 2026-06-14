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
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.Conversation
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.DialogCreateGroupBinding
import com.openboard.nativeapp.databinding.FragmentChatListBinding
import com.openboard.nativeapp.ui.adapter.MergedConversationAdapter
import com.openboard.nativeapp.ui.adapter.MergedItem
import com.openboard.nativeapp.ui.theme.ThemeManager
import kotlinx.coroutines.launch

/**
 * 消息会话主页面，统一展示置顶、最近聊天、所有联系人与群聊的合并列表
 */
class ChatListFragment : Fragment() {
    private var _binding: FragmentChatListBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: MergedConversationAdapter

    private var allGroups: List<com.openboard.nativeapp.data.model.Group> = emptyList()
    private var allUsers: List<com.openboard.nativeapp.data.model.User> = emptyList()

    private val wsListener = object : MainActivity.WsMessageListener {
        override fun onWsMessageReceived(msg: WsMessage) {
            if (msg.type == "online_status") {
                val onlineList = msg.users ?: emptyList()
                adapter.updateOnlineUsers(onlineList)
            } else {
                loadData()
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
        applyTheme()
        
        binding.btnNotifications.setOnClickListener {
            val sheet = NotificationsBottomSheet {
                binding.noticeBadge.visibility = View.GONE
            }
            sheet.show(childFragmentManager, "Notifications")
        }

        binding.fabNewChat.setOnClickListener {
            showCreateGroupDialog()
        }
        
        loadData()
    }

    private fun applyTheme() {
        ThemeManager.applyToHeader(requireContext(), binding.headerLayout)
        ThemeManager.applyToFab(requireContext(), binding.fabNewChat)
    }

    override fun onStart() {
        super.onStart()
        (activity as? MainActivity)?.recentChatsListener = wsListener
        loadData()
        checkNotifications()
    }

    override fun onStop() {
        super.onStop()
        (activity as? MainActivity)?.recentChatsListener = null
    }

    private fun setupRecyclerView() {
        adapter = MergedConversationAdapter(
            onClick = { conv ->
                SessionManager.clearUnread(conv.id, conv.targetUser)
                (activity as? MainActivity)?.navigateToChat(
                    roomId = conv.id,
                    roomName = conv.name,
                    targetUser = conv.targetUser,
                    ownerId = conv.ownerId
                )
            },
            onLongClick = { conv ->
                showChatOptions(conv)
            },
            onPinnedHeaderClick = {
                val currentFolded = SessionManager.isPinnedFolded()
                SessionManager.setPinnedFolded(!currentFolded)
                mergeAndDisplay()
            }
        )
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter
    }

    private fun loadData() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val groupsResult = repository.getGroups()
            val usersResult = repository.getUsers()
            binding.progressBar.visibility = View.GONE

            groupsResult.onSuccess { groups ->
                allGroups = groups
                mergeAndDisplay()
            }
            usersResult.onSuccess { users ->
                allUsers = users
                mergeAndDisplay()
            }
        }
    }

    private fun mergeAndDisplay() {
        val recentConvs = SessionManager.getConversations()
        val recentMap = recentConvs.associateBy {
            if (it.targetUser != null) "user_${it.targetUser}" else "group_${it.id}"
        }
        val myUsername = SessionManager.username ?: ""

        val mergedList = mutableListOf<Conversation>()

        // 1. Process all groups
        allGroups.forEach { g ->
            val key = "group_${g.id}"
            val existing = recentMap[key]
            if (existing != null) {
                mergedList.add(existing)
            } else {
                mergedList.add(
                    Conversation(
                        id = g.id,
                        targetUser = null,
                        name = g.name,
                        lastMessage = "",
                        time = "",
                        avatar = g.avatar,
                        unreadCount = 0,
                        ownerId = g.ownerId
                    )
                )
            }
        }

        // 2. Process all users (filter out current user)
        allUsers.filter { it.username != myUsername }.forEach { u ->
            val key = "user_${u.username}"
            val existing = recentMap[key]
            if (existing != null) {
                mergedList.add(existing)
            } else {
                mergedList.add(
                    Conversation(
                        id = 0,
                        targetUser = u.username,
                        name = u.nickname ?: u.username,
                        lastMessage = "",
                        time = "",
                        avatar = u.avatar,
                        unreadCount = 0,
                        ownerId = 0
                    )
                )
            }
        }

        // Filter out blocked users
        val blockedList = SessionManager.blockedUsers
        val filteredMergedList = mergedList.filter {
            it.targetUser == null || !blockedList.contains(it.targetUser)
        }

        // Split into pinned and non-pinned
        val pinnedList = filteredMergedList.filter { SessionManager.isPinned(it.id, it.targetUser) }
        val nonPinnedList = filteredMergedList.filter { !SessionManager.isPinned(it.id, it.targetUser) }

        // Sort both lists based on:
        // 1. Existing in recent chats first, sorted by index in recent chats list (descending time).
        // 2. Never chatted ones at the bottom, sorted alphabetically.
        val recentOrder = recentConvs.map { if (it.targetUser != null) "user_${it.targetUser}" else "group_${it.id}" }

        val comparator = compareBy<Conversation> {
            val key = if (it.targetUser != null) "user_${it.targetUser}" else "group_${it.id}"
            val index = recentOrder.indexOf(key)
            if (index >= 0) 0 else 1
        }.thenBy {
            val key = if (it.targetUser != null) "user_${it.targetUser}" else "group_${it.id}"
            val index = recentOrder.indexOf(key)
            if (index >= 0) index else 0
        }.thenBy {
            it.name
        }

        val sortedPinned = pinnedList.sortedWith(comparator)
        val sortedNonPinned = nonPinnedList.sortedWith(comparator)

        // Build list for adapter
        val displayList = mutableListOf<MergedItem>()
        if (sortedPinned.isNotEmpty()) {
            displayList.add(MergedItem.PinnedHeader(isFolded = SessionManager.isPinnedFolded()))
            if (!SessionManager.isPinnedFolded()) {
                sortedPinned.forEach {
                    displayList.add(MergedItem.ChatItem(it, isPinned = true))
                }
            }
        }
        displayList.add(MergedItem.AllChatsHeader(count = sortedNonPinned.size))
        sortedNonPinned.forEach {
            displayList.add(MergedItem.ChatItem(it, isPinned = false))
        }

        adapter.submitList(displayList)
    }

    private fun showChatOptions(conv: Conversation) {
        val isPinned = SessionManager.isPinned(conv.id, conv.targetUser)
        val options = if (isPinned) arrayOf("取消置顶") else arrayOf("置顶聊天")

        AlertDialog.Builder(requireContext())
            .setTitle(conv.name)
            .setItems(options) { _, which ->
                if (which == 0) {
                    SessionManager.setPinned(conv.id, conv.targetUser, !isPinned)
                    mergeAndDisplay()
                    Toast.makeText(requireContext(), if (isPinned) "已取消置顶" else "已置顶该聊天", Toast.LENGTH_SHORT).show()
                }
            }
            .show()
    }

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

    private fun createGroup(name: String, description: String?) {
        lifecycleScope.launch {
            val result = repository.createGroup(name, description)
            result.onSuccess { resp ->
                Toast.makeText(requireContext(), "群组创建成功", Toast.LENGTH_SHORT).show()
                loadData()
                
                (activity as? MainActivity)?.navigateToChat(
                    roomId = resp.groupId,
                    roomName = name,
                    ownerId = SessionManager.userId
                )
            }.onFailure { e ->
                Toast.makeText(requireContext(), "创建群组失败: ${e.message}", Toast.LENGTH_SHORT).show()
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
