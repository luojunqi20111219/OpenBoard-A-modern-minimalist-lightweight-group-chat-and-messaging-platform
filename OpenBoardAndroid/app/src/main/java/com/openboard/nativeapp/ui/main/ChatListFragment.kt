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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.model.ApiResponse
import retrofit2.Call
import retrofit2.Callback
import retrofit2.Response
import android.widget.EditText
import android.widget.FrameLayout

/**
 * 消息会话主页面，统一展示置顶、最近聊天、所有联系人与群聊的合并列表
 */
class ChatListFragment : Fragment() {
    private var _binding: FragmentChatListBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()
    private lateinit var adapter: MergedConversationAdapter

    private val barcodeLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents == null) {
            Toast.makeText(context, "已取消扫码", Toast.LENGTH_SHORT).show()
        } else {
            handleQrCodeResult(result.contents)
        }
    }

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

        binding.btnScan.setOnClickListener {
            startQrScan()
        }

        binding.fabNewChat.setOnClickListener {
            showFabOptions()
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
            val usersResult = repository.getFriends()
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

    private fun startQrScan() {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("请对准网页端二维码进行扫描")
            setCameraId(0)
            setBeepEnabled(true)
            setBarcodeImageEnabled(false)
            setOrientationLocked(true)
        }
        barcodeLauncher.launch(options)
    }

    private fun handleQrCodeResult(content: String) {
        if (content.startsWith("openboard:qr_login:")) {
            val qrId = content.substring("openboard:qr_login:".length)
            val api = RetrofitClient.getApiService()
            val req = mapOf("qr_id" to qrId)
            
            api.scanQrCode(req).enqueue(object : Callback<ApiResponse<Any>> {
                override fun onResponse(call: Call<ApiResponse<Any>>, response: Response<ApiResponse<Any>>) {
                    showConfirmLoginDialog(qrId)
                }
                override fun onFailure(call: Call<ApiResponse<Any>>, t: Throwable) {
                    showConfirmLoginDialog(qrId)
                }
            })
        } else if (content.startsWith("openboard:add_friend:")) {
            val username = content.substring("openboard:add_friend:".length)
            showConfirmAddFriendDialog(username)
        } else {
            Toast.makeText(context, "无效的二维码内容", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showConfirmAddFriendDialog(username: String) {
        val myUsername = SessionManager.username ?: ""
        if (username == myUsername) {
            Toast.makeText(context, "不能添加自己为好友", Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(requireContext())
            .setTitle("添加好友")
            .setMessage("确定要添加扫码用户 @$username 为好友吗？")
            .setPositiveButton("发送申请") { _, _ ->
                lifecycleScope.launch {
                    repository.sendFriendRequest(username)
                        .onSuccess {
                            Toast.makeText(context, "好友申请已发送", Toast.LENGTH_SHORT).show()
                        }
                        .onFailure { e ->
                            Toast.makeText(context, "发送申请失败: ${e.message}", Toast.LENGTH_SHORT).show()
                        }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }


    private fun showConfirmLoginDialog(qrId: String) {
        AlertDialog.Builder(requireContext())
            .setTitle("扫码登录确认")
            .setMessage("确定要在网页端登录您的账号吗？")
            .setPositiveButton("确认登录") { _, _ ->
                authorizeQrLogin(qrId)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun authorizeQrLogin(qrId: String) {
        val api = RetrofitClient.getApiService()
        val req = mapOf("qr_id" to qrId)
        api.authorizeQrCode(req).enqueue(object : Callback<ApiResponse<Any>> {
            override fun onResponse(call: Call<ApiResponse<Any>>, response: Response<ApiResponse<Any>>) {
                if (response.isSuccessful && response.body()?.code == 200) {
                    Toast.makeText(context, "网页端登录成功！", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(context, "授权失败，请重试", Toast.LENGTH_SHORT).show()
                }
            }
            override fun onFailure(call: Call<ApiResponse<Any>>, t: Throwable) {
                Toast.makeText(context, "网络错误，授权失败", Toast.LENGTH_SHORT).show()
            }
        })
    }

    private fun showFabOptions() {
        val options = arrayOf("新建群聊", "搜索并添加好友", "查看好友申请")
        AlertDialog.Builder(requireContext())
            .setTitle("新建/管理")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showCreateGroupDialog()
                    1 -> showAddFriendSearchDialog()
                    2 -> showPendingRequestsDialog()
                }
            }
            .show()
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
                    loadData() // Reload friends
                }
                .onFailure { e ->
                    Toast.makeText(requireContext(), "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
        }
    }


    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
