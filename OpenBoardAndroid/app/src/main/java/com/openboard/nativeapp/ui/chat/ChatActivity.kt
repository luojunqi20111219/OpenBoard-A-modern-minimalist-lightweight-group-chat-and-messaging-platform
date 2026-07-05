package com.openboard.nativeapp.ui.chat

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import android.view.ViewGroup
import android.view.Gravity
import android.widget.TextView
import android.view.inputmethod.InputMethodManager
import android.content.Context
import com.google.gson.Gson
import com.openboard.nativeapp.OpenBoardApp
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.Group
import com.openboard.nativeapp.data.model.Message
import com.openboard.nativeapp.data.model.SendMessageRequest
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.ActivityChatBinding
import com.openboard.nativeapp.databinding.DialogGroupSettingsBinding
import com.openboard.nativeapp.ui.adapter.ChatAdapter
import com.openboard.nativeapp.ui.theme.ThemeManager
import coil.load
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream

/**
 * 聊天室 Activity，处理公共大厅、私聊以及群聊消息交互，支持打字态、附件上传、消息撤回、拉黑与群组权限配置。
 */
class ChatActivity : AppCompatActivity() {
    private lateinit var binding: ActivityChatBinding
    private val repository = ChatRepository()
    private val messagesList = mutableListOf<Message>()
    private val favoriteEmojis = mutableListOf<String>()
    private var currentEmojis: List<String> = emptyList()
    private lateinit var adapter: ChatAdapter

    private var roomId = 0
    private var roomName = "大厅"
    private var targetUser: String? = null
    private var ownerId = 0

    // 附件与群头像选择模式
    private enum class PickerMode { ATTACHMENT, GROUP_AVATAR }
    private var currentPickerMode = PickerMode.ATTACHMENT

    // 输入态限频及定时器
    private var lastTypingSentTime = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val typingTimeoutRunnable = Runnable {
        binding.tvSubtitle.visibility = View.GONE
    }

    // 缓存的群设置弹窗实例及待上传的群头像
    private var groupSettingsDialog: AlertDialog? = null
    private var groupSettingsBinding: DialogGroupSettingsBinding? = null
    private var pendingGroupAvatarBase64: String? = null

    // 缓存黑名单状态
    private var isTargetUserBlocked = false
    private var replyingMessage: Message? = null

    // WebSocket 实时数据监听器
    private val wsListener = object : WebSocketManager.WsListener {
        override fun onMessage(msg: WsMessage) {
            runOnUiThread {
                handleWebSocketMessage(msg)
            }
        }
    }

    // 相册/文件选择器
    private val pickMediaLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            when (currentPickerMode) {
                PickerMode.ATTACHMENT -> uploadAttachment(it)
                PickerMode.GROUP_AVATAR -> processGroupAvatar(it)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityChatBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyTheme()

        // 解析 Intent 参数
        roomId = intent.getIntExtra("room_id", 0)
        roomName = intent.getStringExtra("room_name") ?: "群聊"
        targetUser = intent.getStringExtra("target_user")
        ownerId = intent.getIntExtra("owner_id", 0)

        setupUI()
        loadMessages()

        WebSocketManager.addListener(wsListener)
    }

    private fun applyTheme() {
        ThemeManager.applyToHeader(this, binding.toolbar)
        ThemeManager.applyToSendButton(this, binding.btnSend)
        ThemeManager.applyChatBackground(this, binding.recyclerView)
        ThemeManager.applyTintToButtons(this, binding.btnAttach, binding.btnEmoji)
    }

    /**
     * 初始化聊天室界面、标题栏按钮、输入监听及消息发送
     */
    private fun setupUI() {
        binding.tvTitle.text = roomName
        binding.btnBack.setOnClickListener { finish() }

        // 配置顶部操作栏按钮 (私聊:拉黑/解黑, 群聊:群设置管理)
        val myUsername = SessionManager.username
        val myRole = SessionManager.getUser().role
        val isAdmin = myRole == 1 // 是否为系统管理员

        if (roomId > 0) {
            // 群聊中，只有群主或系统管理员可以修改群设置
            if (ownerId == SessionManager.userId || isAdmin) {
                binding.btnAction.visibility = View.VISIBLE
                binding.btnAction.text = "群设置"
                binding.btnAction.setOnClickListener { showGroupSettingsDialog() }
            }
        } else if (targetUser != null) {
            if (targetUser == "filehelper") {
                binding.btnAction.visibility = View.GONE
            } else {
                binding.btnAction.visibility = View.VISIBLE
                binding.btnAction.text = "删除好友"
                binding.btnAction.setTextColor(resources.getColor(android.R.color.white, null))
                binding.btnAction.setOnClickListener { confirmRemoveFriend() }
            }
        }

        // 初始化 RecyclerView 适配器
        adapter = ChatAdapter(messagesList, myUsername ?: "")
        adapter.onMessageLongClick = { msg -> showMessageOptions(msg) }
        adapter.onAvatarClick = { msg -> showUserProfileDialog(msg) }
        adapter.onActionOptionClick = { option, msg, selectedText ->
            handleActionOption(option, msg, selectedText)
        }
        adapter.onReplyQuoteClick = { parentId ->
            val index = messagesList.indexOfFirst { it.id == parentId }
            if (index >= 0) {
                binding.recyclerView.smoothScrollToPosition(index)
                adapter.highlightItem(index)
            } else {
                Toast.makeText(this, "未找到引用的原始消息", Toast.LENGTH_SHORT).show()
            }
        }
        binding.recyclerView.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true // 从底部开始堆叠，符合聊天习惯
        }
        binding.recyclerView.adapter = adapter

        // 取消回复按钮
        binding.btnCancelReply.setOnClickListener { cancelReply() }

        // 附件上传点击
        binding.btnAttach.setOnClickListener {
            val options = arrayOf("发送图片", "发送文件", "推送好友名片")
            AlertDialog.Builder(this)
                .setTitle("选择操作")
                .setItems(options) { _, which ->
                    when (which) {
                        0 -> {
                            currentPickerMode = PickerMode.ATTACHMENT
                            pickMediaLauncher.launch("image/*")
                        }
                        1 -> {
                            currentPickerMode = PickerMode.ATTACHMENT
                            pickMediaLauncher.launch("*/*")
                        }
                        2 -> {
                            showShareCardFriendListDialog()
                        }
                    }
                }
                .show()
        }

        // 发送按钮点击
        binding.btnSend.setOnClickListener { sendMessage() }

        // 初始化发送按钮不可发送样式
        updateSendButtonState(false)

        // 输入框变化监听，用于上报“正在输入...”状态
        binding.etMessage.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                triggerTypingIndicator()
                updateSendButtonState(!s.isNullOrBlank())
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        setupEmojiPicker()
    }

    /**
     * 发送输入状态到服务器（节流阀限制：2.5秒一次）
     */
    private fun triggerTypingIndicator() {
        val now = System.currentTimeMillis()
        if (now - lastTypingSentTime > 2500) {
            val typingFrame = mapOf(
                "type" to "typing",
                "room_id" to roomId,
                "receiver" to targetUser
            )
            WebSocketManager.send(Gson().toJson(typingFrame))
            lastTypingSentTime = now
        }
    }

    /**
     * 拉取并渲染最近 100 条聊天历史记录
     */
    private fun loadMessages() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.getMessages(roomId, targetUser)
            binding.progressBar.visibility = View.GONE
            result.onSuccess { msgs ->
                messagesList.clear()
                messagesList.addAll(msgs)
                adapter.notifyDataSetChanged()
                scrollToBottom()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "加载历史消息失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 发送普通文本消息
     */
    private fun sendMessage() {
        val content = binding.etMessage.text.toString().trim()
        if (content.isEmpty()) return

        val finalContent = if (replyingMessage != null) {
            val originalMsg = replyingMessage!!
            val cleanOriginalText = when {
                originalMsg.content.contains("[img:") -> "[图片]"
                originalMsg.content.contains("[file:") -> "[文件]"
                else -> originalMsg.content
            }
            "💬 回复 @${originalMsg.nickname ?: originalMsg.name}：\n\"${cleanOriginalText}\"\n\n$content"
        } else {
            content
        }

        val request = SendMessageRequest(
            content = finalContent,
            roomId = roomId,
            receiver = targetUser,
            replyTo = replyingMessage?.id
        )

        binding.etMessage.text.clear()
        cancelReply()

        lifecycleScope.launch {
            val result = repository.sendMessage(request)
            result.onSuccess {
                loadMessages()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "发送失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 异步上传附件并将格式化标签发往聊天室
     */
    private fun uploadAttachment(uri: Uri) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val part = getMultipartBodyPart(uri)
                if (part == null) {
                    binding.progressBar.visibility = View.GONE
                    Toast.makeText(this@ChatActivity, "无法读取文件数据", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                val result = repository.uploadFile(part)
                binding.progressBar.visibility = View.GONE
                result.onSuccess { resp ->
                    val url = resp.url ?: ""
                    val downloadUrl = resp.downloadUrl ?: ""
                    val filename = resp.filename ?: "file"
                    
                    // 判断是否为图片类型
                    val mimeType = contentResolver.getType(uri) ?: ""
                    val isImage = mimeType.startsWith("image/") ||
                            filename.endsWith(".jpg", ignoreCase = true) ||
                            filename.endsWith(".jpeg", ignoreCase = true) ||
                            filename.endsWith(".png", ignoreCase = true) ||
                            filename.endsWith(".gif", ignoreCase = true) ||
                            filename.endsWith(".webp", ignoreCase = true)

                    val formattedMsg = if (isImage) {
                        "[img:$url]"
                    } else {
                        "[file:$downloadUrl|$filename]"
                    }

                    // 自动发送附件标签消息
                    val sendResult = repository.sendMessage(
                        SendMessageRequest(
                            content = formattedMsg,
                            roomId = roomId,
                            receiver = targetUser
                        )
                    )
                    sendResult.onSuccess {
                        loadMessages()
                    }.onFailure { e ->
                        Toast.makeText(this@ChatActivity, "发送附件消息失败: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }.onFailure { e ->
                    Toast.makeText(this@ChatActivity, "文件上传失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                binding.progressBar.visibility = View.GONE
                Toast.makeText(this@ChatActivity, "上传异常: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showShareCardFriendListDialog() {
        lifecycleScope.launch {
            binding.progressBar.visibility = View.VISIBLE
            val result = repository.getFriends()
            binding.progressBar.visibility = View.GONE
            
            result.onSuccess { friends ->
                val myUsername = SessionManager.username ?: ""
                val filtered = friends.filter { it.username != "filehelper" && it.username != myUsername }
                
                if (filtered.isEmpty()) {
                    Toast.makeText(this@ChatActivity, "暂无好友可推荐", Toast.LENGTH_SHORT).show()
                    return@onSuccess
                }
                
                val displayNames = filtered.map { it.nickname ?: it.username }.toTypedArray()
                
                AlertDialog.Builder(this@ChatActivity)
                    .setTitle("选择要推荐的好友")
                    .setItems(displayNames) { _, which ->
                        val target = filtered[which]
                        val encodedNickname = java.net.URLEncoder.encode(target.nickname ?: target.username, "UTF-8")
                        val cardContent = "[user_card:${target.username}:$encodedNickname]"
                        
                        lifecycleScope.launch {
                            val sendResult = repository.sendMessage(
                                SendMessageRequest(
                                    content = cardContent,
                                    roomId = roomId,
                                    receiver = targetUser
                                )
                            )
                            sendResult.onSuccess {
                                loadMessages()
                            }.onFailure { e ->
                                Toast.makeText(this@ChatActivity, "发送名片失败: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                    .show()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "获取好友列表失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 辅助方法：从 URI 生成 OkHttp Multipart 部件
     */
    private fun getMultipartBodyPart(uri: Uri): MultipartBody.Part? {
        val contentResolver = contentResolver
        val inputStream = contentResolver.openInputStream(uri) ?: return null
        val bytes = inputStream.readBytes()
        inputStream.close()

        var filename = "file"
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0) {
                    filename = cursor.getString(nameIndex)
                }
            }
        }

        val mediaType = (contentResolver.getType(uri) ?: "application/octet-stream").toMediaTypeOrNull()
        val requestBody = bytes.toRequestBody(mediaType)
        return MultipartBody.Part.createFormData("file", filename, requestBody)
    }

    /**
     * 接收并动态渲染 WebSocket 实时广播包
     */
    private fun handleWebSocketMessage(msg: WsMessage) {
        val me = SessionManager.username ?: return
        when (msg.type) {
            "message" -> {
                msg.data?.let { data ->
                    val isMsgForCurrentChat = if (roomId > 0) {
                        data.roomId == roomId
                    } else {
                        data.roomId == 0 && (
                            (data.name == targetUser && data.receiver == me) ||
                            (data.name == me && data.receiver == targetUser)
                        )
                    }

                    if (isMsgForCurrentChat) {
                        if (messagesList.none { it.id == data.id }) {
                            val newMessage = Message(
                                id = data.id ?: 0,
                                name = data.name ?: "",
                                content = data.content ?: "",
                                time = data.time ?: "刚刚",
                                nickname = data.nickname,
                                avatar = data.avatar,
                                reply = data.replyTo?.toString(),
                                roomId = data.roomId ?: 0,
                                receiver = data.receiver
                            )
                            messagesList.add(newMessage)
                            adapter.notifyItemInserted(messagesList.size - 1)
                            scrollToBottom()
                        }
                    }
                }
            }
            "recall" -> {
                val index = messagesList.indexOfFirst { it.id == msg.msgId }
                if (index >= 0) {
                    val oldMsg = messagesList[index]
                    messagesList[index] = oldMsg.copy(isRecalled = 1)
                    adapter.notifyItemChanged(index)
                }
            }
            "typing" -> {
                if (msg.user == me) return
                val isTypingForCurrentChat = if (roomId > 0) {
                    msg.roomId == roomId
                } else {
                    msg.roomId == 0 && msg.user == targetUser
                }

                if (isTypingForCurrentChat) {
                    val text = if (roomId > 0) "${msg.user}正在输入..." else "正在输入..."
                    binding.tvSubtitle.text = text
                    binding.tvSubtitle.visibility = View.VISIBLE
                    mainHandler.removeCallbacks(typingTimeoutRunnable)
                    mainHandler.postDelayed(typingTimeoutRunnable, 3000)
                }
            }
        }
    }

    /**
     * 长按消息气泡呼出撤回等选项菜单
     */
    private fun showMessageOptions(message: Message) {
        val myUsername = SessionManager.username ?: return
        val myRole = SessionManager.getUser().role
        val isAdmin = myRole == 1

        val options = mutableListOf<String>()
        options.add("复制文本")
        options.add("回复 (引用)")
        options.add("转发消息")
        options.add("翻译消息")
        
        val isImageMessage = message.content.contains("[img:")
        if (isImageMessage) {
            options.add("收藏表情")
        }
        
        if (message.name == myUsername || isAdmin) {
            options.add("撤回消息")
        }

        AlertDialog.Builder(this)
            .setItems(options.toTypedArray()) { _, which ->
                handleActionOption(options[which], message, message.content)
            }
            .show()
    }

    private fun handleActionOption(option: String, message: Message, selectedText: String) {
        when (option) {
            "复制文本" -> {
                val clipboard = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                val clip = android.content.ClipData.newPlainText("message", selectedText)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(this, "已复制到剪贴板", Toast.LENGTH_SHORT).show()
            }
            "回复 (引用)" -> {
                val customMessage = message.copy(content = selectedText)
                startReply(customMessage)
            }
            "转发消息" -> {
                forwardMessage(selectedText)
            }
            "翻译消息" -> {
                val customMessage = message.copy(content = selectedText)
                translateMessage(customMessage)
            }
            "收藏表情" -> {
                val regex = "\\[img:([^]]+)\\]".toRegex()
                val match = regex.find(selectedText)
                if (match != null) {
                    val imgTag = match.value
                    toggleFavoriteEmoji(imgTag)
                } else {
                    Toast.makeText(this, "未找到可收藏的表情图片", Toast.LENGTH_SHORT).show()
                }
            }
            "撤回消息" -> {
                recallMessage(message.id)
            }
        }
    }

    /**
     * 撤回消息
     */
    private fun recallMessage(msgId: Int) {
        lifecycleScope.launch {
            val result = repository.recallMessage(msgId)
            result.onSuccess {
                Toast.makeText(this@ChatActivity, "已撤回消息", Toast.LENGTH_SHORT).show()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "撤回失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun confirmRemoveFriend() {
        val target = targetUser ?: return
        AlertDialog.Builder(this)
            .setTitle("删除好友")
            .setMessage("确定要删除好友 @$target 吗？删除后你们将无法发送私信。")
            .setPositiveButton("删除") { _, _ ->
                doRemoveFriend(target)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doRemoveFriend(target: String) {
        lifecycleScope.launch {
            val result = repository.removeFriend(target)
            result.onSuccess {
                Toast.makeText(this@ChatActivity, "已成功删除该好友", Toast.LENGTH_SHORT).show()
                finish() // Close the chat screen
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "删除好友失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 弹出群组详细属性设置弹窗（群主/管理员权限）
     */
    private fun showGroupSettingsDialog() {
        groupSettingsBinding = DialogGroupSettingsBinding.inflate(LayoutInflater.from(this))
        val b = groupSettingsBinding!!

        pendingGroupAvatarBase64 = null

        // 异步获取群详情以填充初始权限数据
        lifecycleScope.launch {
            val result = repository.getGroups()
            result.onSuccess { list ->
                val group = list.firstOrNull { it.id == roomId } ?: return@onSuccess
                
                b.etGroupName.setText(group.name)
                
                // 填充 View Mode
                if (group.viewMode == 1) {
                    b.rbViewPrivate.isChecked = true
                } else {
                    b.rbViewPublic.isChecked = true
                }

                // 填充 Speak Mode
                if (group.speakMode == 1) {
                    b.rbSpeakPrivate.isChecked = true
                } else {
                    b.rbSpeakPublic.isChecked = true
                }

                b.etBlackView.setText(group.blackView ?: "")
                b.etWhiteView.setText(group.whiteView ?: "")
                b.etBlackSpeak.setText(group.blackSpeak ?: "")
                b.etWhiteSpeak.setText(group.whiteSpeak ?: "")

                // 渲染群头像
                renderGroupSettingsAvatar(group.avatar)
            }
        }

        // 修改群头像点击
        b.ivGroupAvatar.setOnClickListener {
            currentPickerMode = PickerMode.GROUP_AVATAR
            pickMediaLauncher.launch("image/*")
        }

        // 解散群聊点击
        b.btnDisbandGroup.setOnClickListener {
            showDisbandGroupConfirmation()
        }

        groupSettingsDialog = AlertDialog.Builder(this)
            .setTitle("群组管理设置")
            .setView(b.root)
            .setPositiveButton("保存更改") { _, _ ->
                saveGroupSettings()
            }
            .setNegativeButton("取消", null)
            .create()

        groupSettingsDialog?.show()
    }

    /**
     * 解析并渲染群设置 ImageView 中的 Base64 头像
     */
    private fun renderGroupSettingsAvatar(avatarStr: String?) {
        val iv = groupSettingsBinding?.ivGroupAvatar ?: return
        if (!avatarStr.isNullOrEmpty()) {
            try {
                val base64Data = if (avatarStr.startsWith("data:image")) {
                    avatarStr.substringAfter("base64,")
                } else {
                    avatarStr
                }
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                iv.setImageBitmap(bmp)
            } catch (e: Exception) {
                iv.setImageResource(R.drawable.ic_group)
            }
        } else {
            iv.setImageResource(R.drawable.ic_group)
        }
    }

    /**
     * 对群设置选中的新头像进行转码 Base64 并在 Dialog 中预览
     */
    private fun processGroupAvatar(uri: Uri) {
        lifecycleScope.launch {
            try {
                val inputStream = contentResolver.openInputStream(uri)
                val rawBytes = inputStream?.readBytes()
                inputStream?.close()

                if (rawBytes != null) {
                    var bmp = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)
                    
                    // 群头像尺寸压缩
                    if (rawBytes.size > 100 * 1024) {
                        val out = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.JPEG, 60, out)
                        val compressed = out.toByteArray()
                        bmp = BitmapFactory.decodeByteArray(compressed, 0, compressed.size)
                    }

                    val out = ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
                    val base64Str = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                    
                    pendingGroupAvatarBase64 = base64Str
                    groupSettingsBinding?.ivGroupAvatar?.setImageBitmap(bmp)
                }
            } catch (e: Exception) {
                Toast.makeText(this@ChatActivity, "处理群头像失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 保存群设置 (同时修改群名、头像与黑白名单权限)
     */
    private fun saveGroupSettings() {
        val b = groupSettingsBinding ?: return
        val newName = b.etGroupName.text.toString().trim()
        if (newName.isEmpty()) {
            Toast.makeText(this, "群聊名称不能为空", Toast.LENGTH_SHORT).show()
            return
        }

        binding.progressBar.visibility = View.VISIBLE

        lifecycleScope.launch {
            try {
                // 1. 修改群名称
                repository.updateGroup(roomId, newName)
                roomName = newName
                binding.tvTitle.text = roomName

                // 2. 修改群头像 (如果被修改过)
                pendingGroupAvatarBase64?.let { avatarBase64 ->
                    repository.updateGroupAvatar(roomId, avatarBase64)
                }

                // 3. 配置权限参数
                val viewMode = if (b.rbViewPrivate.isChecked) 1 else 0
                val speakMode = if (b.rbSpeakPrivate.isChecked) 1 else 0
                val blackView = b.etBlackView.text.toString().trim()
                val whiteView = b.etWhiteView.text.toString().trim()
                val blackSpeak = b.etBlackSpeak.text.toString().trim()
                val whiteSpeak = b.etWhiteSpeak.text.toString().trim()

                val permissions = mapOf(
                    "view_mode" to viewMode,
                    "speak_mode" to speakMode,
                    "black_view" to blackView,
                    "white_view" to whiteView,
                    "black_speak" to blackSpeak,
                    "white_speak" to whiteSpeak
                )

                repository.updateGroupPermissions(roomId, permissions)

                binding.progressBar.visibility = View.GONE
                Toast.makeText(this@ChatActivity, "群设置保存成功", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                binding.progressBar.visibility = View.GONE
                Toast.makeText(this@ChatActivity, "保存失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 解散群组二次确认
     */
    private fun showDisbandGroupConfirmation() {
        AlertDialog.Builder(this)
            .setTitle("⚠️ 警示：解散此群组")
            .setMessage("确定要解散该群组吗？此操作将永久抹除所有聊天内容。")
            .setPositiveButton("解散") { _, _ ->
                disbandGroup()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 发起解散群组请求并退出聊天室
     */
    private fun disbandGroup() {
        groupSettingsDialog?.dismiss()
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.deleteGroup(roomId)
            binding.progressBar.visibility = View.GONE
            result.onSuccess {
                Toast.makeText(this@ChatActivity, "群聊已成功解散", Toast.LENGTH_SHORT).show()
                finish()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "解散群聊失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun scrollToBottom() {
        if (messagesList.isNotEmpty()) {
            binding.recyclerView.scrollToPosition(messagesList.size - 1)
        }
    }

    override fun onResume() {
        super.onResume()
        // 设置当前活跃的聊天室，防止在此房间时弹出推送通知
        val app = application as OpenBoardApp
        app.activeRoomId = roomId
        app.activeTargetUser = targetUser
    }

    override fun onPause() {
        super.onPause()
        // 清除活跃的聊天室
        val app = application as OpenBoardApp
        if (app.activeRoomId == roomId && app.activeTargetUser == targetUser) {
            app.activeRoomId = -1
            app.activeTargetUser = null
        }
    }

    private fun updateSendButtonState(hasText: Boolean) {
        binding.btnSend.isEnabled = hasText
        if (hasText) {
            binding.btnSend.backgroundTintList = null
            binding.btnSend.imageTintList = android.content.res.ColorStateList.valueOf(resources.getColor(android.R.color.white, null))
            binding.btnSend.alpha = 1.0f
        } else {
            binding.btnSend.backgroundTintList = android.content.res.ColorStateList.valueOf(0x22888888.toInt())
            binding.btnSend.imageTintList = android.content.res.ColorStateList.valueOf(0xFF888888.toInt())
            binding.btnSend.alpha = 0.5f
        }
    }

    private fun cancelReply() {
        replyingMessage = null
        binding.layoutReplyPreview.visibility = View.GONE
    }

    private fun startReply(message: Message) {
        replyingMessage = message
        binding.tvReplyUser.text = "回复 @${message.nickname ?: message.name}"
        binding.tvReplyContent.text = when {
            message.content.contains("[img:") -> "[图片]"
            message.content.contains("[file:") -> "[文件]"
            else -> message.content
        }
        binding.layoutReplyPreview.visibility = View.VISIBLE
    }

    private fun forwardMessage(messageContent: String) {
        val conversations = SessionManager.getConversations()
        if (conversations.isEmpty()) {
            Toast.makeText(this, "暂无可转发的会话", Toast.LENGTH_SHORT).show()
            return
        }
        val names = conversations.map { it.name }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("转发消息到...")
            .setItems(names) { _, which ->
                val target = conversations[which]
                val targetRoomId = target.id
                val targetUser = target.targetUser
                lifecycleScope.launch {
                    val request = SendMessageRequest(
                        content = messageContent,
                        roomId = targetRoomId,
                        receiver = targetUser
                    )
                    val result = repository.sendMessage(request)
                    result.onSuccess {
                        Toast.makeText(this@ChatActivity, "已转发给 ${target.name}", Toast.LENGTH_SHORT).show()
                        if (targetRoomId == roomId && targetUser == this@ChatActivity.targetUser) {
                            loadMessages()
                        }
                    }.onFailure { e ->
                        Toast.makeText(this@ChatActivity, "转发失败: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .show()
    }

    private fun translateMessage(message: Message) {
        val text = message.content
        val isChinese = text.any { it.code in 0x4e00..0x9fa5 }
        val targetLang = if (isChinese) "en" else "zh-CN"
        val url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=$targetLang&dt=t&q=${java.net.URLEncoder.encode(text, "UTF-8")}"
        
        binding.progressBar.visibility = View.VISIBLE
        
        val client = okhttp3.OkHttpClient()
        val request = okhttp3.Request.Builder().url(url).build()
        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    Toast.makeText(this@ChatActivity, "翻译失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                runOnUiThread { binding.progressBar.visibility = View.GONE }
                val bodyStr = response.body?.string()
                if (response.isSuccessful && !bodyStr.isNullOrEmpty()) {
                    try {
                        val jsonArray = com.google.gson.JsonParser.parseString(bodyStr).asJsonArray
                        val translatedParts = jsonArray.get(0).asJsonArray
                        val sb = StringBuilder()
                        for (i in 0 until translatedParts.size()) {
                            sb.append(translatedParts.get(i).asJsonArray.get(0).asString)
                        }
                        val translationResult = sb.toString()
                        runOnUiThread {
                            AlertDialog.Builder(this@ChatActivity)
                                .setTitle("翻译结果 (${targetLang})")
                                .setMessage(translationResult)
                                .setPositiveButton("复制") { _, _ ->
                                    val clipboard = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                    val clip = android.content.ClipData.newPlainText("translation", translationResult)
                                    clipboard.setPrimaryClip(clip)
                                    Toast.makeText(this@ChatActivity, "翻译已复制", Toast.LENGTH_SHORT).show()
                                }
                                .setNegativeButton("确定", null)
                                .show()
                        }
                    } catch (e: Exception) {
                        runOnUiThread {
                            Toast.makeText(this@ChatActivity, "解析翻译失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                } else {
                    runOnUiThread {
                        Toast.makeText(this@ChatActivity, "翻译服务异常", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        })
    }

    private fun showUserProfileDialog(message: Message) {
        val target = message.name
        if (target == "filehelper") {
            AlertDialog.Builder(this)
                .setTitle("文件传输助手")
                .setMessage("这是您的个人专属文件传输助手，发送到这里的消息、图片与文件都将保存在云端并同步到您的其他设备。")
                .setPositiveButton("确定", null)
                .show()
            return
        }
        val isMe = target == SessionManager.username
        
        val dialog = AlertDialog.Builder(this).create()
        
        val root = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(60, 60, 60, 60)
            setBackgroundColor(0xFFFFFFFF.toInt())
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, 
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        
        val ivAvatar = com.google.android.material.imageview.ShapeableImageView(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(250, 250).apply {
                gravity = android.view.Gravity.CENTER_HORIZONTAL
                bottomMargin = 40
            }
            scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
            shapeAppearanceModel = com.google.android.material.shape.ShapeAppearanceModel.builder()
                .setAllCornerSizes(125f)
                .build()
        }
        root.addView(ivAvatar)
        
        val tvNickname = android.widget.TextView(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, 
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 10
            }
            text = message.nickname ?: target
            textSize = 20f
            setTypeface(null, android.graphics.Typeface.BOLD)
            gravity = android.view.Gravity.CENTER
            setTextColor(0xFF212121.toInt())
        }
        root.addView(tvNickname)
        
        val tvName = android.widget.TextView(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, 
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 60
            }
            text = "@$target"
            textSize = 14f
            gravity = android.view.Gravity.CENTER
            setTextColor(0xFF757575.toInt())
        }
        root.addView(tvName)
        
        val avatarStr = message.avatar
        if (!avatarStr.isNullOrEmpty()) {
            try {
                val base64Data = if (avatarStr.startsWith("data:image")) {
                    avatarStr.substringAfter("base64,")
                } else {
                    avatarStr
                }
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                ivAvatar.setImageBitmap(bmp)
            } catch (e: Exception) {
                ivAvatar.setImageResource(R.drawable.ic_person)
            }
        } else {
            ivAvatar.setImageResource(R.drawable.ic_person)
        }
        
        val buttonContainer = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        root.addView(buttonContainer)
        
        if (!isMe) {
            val tvLoading = android.widget.TextView(this).apply {
                text = "正在获取好友状态..."
                gravity = android.view.Gravity.CENTER
                setPadding(0, 20, 0, 20)
                setTextColor(0xFF757575.toInt())
            }
            buttonContainer.addView(tvLoading)
            
            lifecycleScope.launch {
                val result = repository.searchUsers(target)
                buttonContainer.removeAllViews()
                
                result.onSuccess { users ->
                    val u = users.find { it.username == target }
                    if (u != null) {
                        tvNickname.text = u.nickname ?: target
                        val serverAvatar = u.avatar
                        if (!serverAvatar.isNullOrEmpty() && avatarStr.isNullOrEmpty()) {
                            try {
                                val base64Data = if (serverAvatar.startsWith("data:image")) {
                                    serverAvatar.substringAfter("base64,")
                                } else {
                                    serverAvatar
                                }
                                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                                ivAvatar.setImageBitmap(bmp)
                            } catch (e: Exception) {}
                        }
                        
                        if (u.isFriend == true) {
                            val btnChat = android.widget.Button(this@ChatActivity).apply {
                                layoutParams = android.widget.LinearLayout.LayoutParams(
                                    android.view.ViewGroup.LayoutParams.MATCH_PARENT, 
                                    android.view.ViewGroup.LayoutParams.WRAP_CONTENT
                                ).apply { bottomMargin = 20 }
                                text = "发消息"
                                setTextColor(0xFFFFFFFF.toInt())
                                setBackgroundColor(resources.getColor(R.color.primary, null))
                                setOnClickListener {
                                    dialog.dismiss()
                                    if (targetUser == target) return@setOnClickListener
                                    val intent = Intent(this@ChatActivity, ChatActivity::class.java).apply {
                                        putExtra("room_id", 0)
                                        putExtra("room_name", u.nickname ?: target)
                                        putExtra("target_user", target)
                                    }
                                    startActivity(intent)
                                    finish()
                                }
                            }
                            buttonContainer.addView(btnChat)
                            
                            val btnDelete = android.widget.Button(this@ChatActivity).apply {
                                layoutParams = android.widget.LinearLayout.LayoutParams(
                                    android.view.ViewGroup.LayoutParams.MATCH_PARENT, 
                                    android.view.ViewGroup.LayoutParams.WRAP_CONTENT
                                )
                                text = "删除好友"
                                setTextColor(0xFFFFFFFF.toInt())
                                setBackgroundColor(0xFFE53935.toInt())
                                setOnClickListener {
                                    dialog.dismiss()
                                    AlertDialog.Builder(this@ChatActivity)
                                        .setTitle("删除好友")
                                        .setMessage("确定要删除好友 @$target 吗？删除后你们将无法发送私信。")
                                        .setPositiveButton("删除") { _, _ ->
                                            lifecycleScope.launch {
                                                repository.removeFriend(target).onSuccess {
                                                    Toast.makeText(this@ChatActivity, "已成功删除该好友", Toast.LENGTH_SHORT).show()
                                                    if (targetUser == target) finish()
                                                }.onFailure { e ->
                                                    Toast.makeText(this@ChatActivity, "删除失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                                }
                                            }
                                        }
                                        .setNegativeButton("取消", null)
                                        .show()
                                }
                            }
                            buttonContainer.addView(btnDelete)
                        } else {
                            val btnAdd = android.widget.Button(this@ChatActivity).apply {
                                layoutParams = android.widget.LinearLayout.LayoutParams(
                                    android.view.ViewGroup.LayoutParams.MATCH_PARENT, 
                                    android.view.ViewGroup.LayoutParams.WRAP_CONTENT
                                )
                                setTextColor(0xFFFFFFFF.toInt())
                                setBackgroundColor(resources.getColor(R.color.primary, null))
                                
                                when {
                                    u.requestStatus == "pending" && u.requestDirection == "sent" -> {
                                        text = "已发送验证 (等待验证)"
                                        isEnabled = false
                                        alpha = 0.6f
                                    }
                                    u.requestStatus == "pending" && u.requestDirection == "received" -> {
                                        text = "同意好友验证申请"
                                        setOnClickListener {
                                            dialog.dismiss()
                                            lifecycleScope.launch {
                                                repository.respondFriendRequest(target, "accept").onSuccess {
                                                    Toast.makeText(this@ChatActivity, "已同意好友申请", Toast.LENGTH_SHORT).show()
                                                }.onFailure { e ->
                                                    Toast.makeText(this@ChatActivity, "处理失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                                }
                                            }
                                        }
                                    }
                                    else -> {
                                        text = "加为好友"
                                        setOnClickListener {
                                            dialog.dismiss()
                                            lifecycleScope.launch {
                                                repository.sendFriendRequest(target).onSuccess {
                                                    Toast.makeText(this@ChatActivity, "好友申请已发送", Toast.LENGTH_SHORT).show()
                                                }.onFailure { e ->
                                                    Toast.makeText(this@ChatActivity, "发送失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            buttonContainer.addView(btnAdd)
                        }
                    } else {
                        val tvError = android.widget.TextView(this@ChatActivity).apply {
                            text = "无法获取该用户信息"
                            gravity = android.view.Gravity.CENTER
                            setTextColor(0xFFE53935.toInt())
                        }
                        buttonContainer.addView(tvError)
                    }
                }.onFailure { e ->
                    val tvError = android.widget.TextView(this@ChatActivity).apply {
                        text = "加载失败: ${e.message}"
                        gravity = android.view.Gravity.CENTER
                        setTextColor(0xFFE53935.toInt())
                    }
                    buttonContainer.addView(tvError)
                }
            }
        }
        
        dialog.setView(root)
        dialog.show()
    }

    private fun setupEmojiPicker() {
        val smileys = listOf(
            "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", 
            "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🤩", "🥳", "😏", 
            "😒", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", 
            "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🤭", "🤫", "🤥", 
            "😶", "😐", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "🤐", 
            "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠", "😈", "👿", "👹", "👺", "🤡", "💩", "👻", 
            "💀", "☠️", "👽", "👾", "🤖", "🎃", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾"
        )
        
        val people = listOf(
            "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", 
            "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", 
            "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🦷", "🦴", "👀", "👁️", "👅", "👄", "💋",
            "👶", "👧", "🧒", "👦", "👩", "🧑", "👨", "👵", "🧓", "👴", "👲", "👮‍♀️", "👮", "👮‍♂️", "👷‍♀️", "👷", 
            "👷‍♂️", "👩‍⚕️", "🧑‍⚕️", "👨‍⚕️", "👩‍🌾", "🧑‍🌾", "👨‍🌾", "👩‍🍳", "🧑‍🍳", "👨‍🍳", "👩‍🎓", "🧑‍🎓", "👨‍🎓", "👩‍🏫", 
            "🧑‍🏫", "👨‍🏫", "👩‍💻", "🧑‍💻", "👨‍💻", "👩‍💼", "🧑‍💼", "👨‍💼", "👩‍🔧", "🧑‍🔧", "👨‍🔧", "👩‍🔬", "🧑‍🔬", "👨‍🔬", 
            "👩‍🎨", "🧑‍🎨", "👨‍🎨", "👩‍🚒", "🧑‍🚒", "👨‍🚒", "👩‍✈️", "🧑‍✈️", "👨‍✈️", "👩‍🚀", "🧑‍🚀", "👨‍🚀", "👩‍⚖️", "🧑‍⚖️", 
            "👨‍⚖️", "👰‍♀️", "👰", "👰‍♂️", "🤵‍♀️", "🤵", "🤵‍♂️", "👸", "🤴", "🥷", "🦸‍♀️", "🦸", "🦸‍♂️", "🦹‍♀️", "🦹", 
            "🦹‍♂️", "🤶", "🧑‍🎄", "🎅", "🧙‍♀️", "🧙", "🧙‍♂️", "🧝‍♀️", "🧝", "🧝‍♂️", "🧛‍♀️", "🧛", "🧛‍♂️", "🧟‍♀️", "🧟"
        )
        
        val animals = listOf(
            "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐽", "🐸", "🐵",
            "🙈", "🙉", "🙊", "🐒", "🐔", "🐧", "🐦", "🐤", "🐣", "🐥", "🦆", "🦢", "🦉", "🦤", "🪶", "🦅",
            "🦜", "🐺", "🐗", "🐴", "🦄", "🐝", "🪱", "🐛", "🦋", "🐌", "🐞", "🐜", "🪰", "🪲", "🪳", "🕷️",
            "🕸️", "🦂", "🦟", "🦠", "🐢", "🐍", "🦎", "🦖", "🦕", "🐙", "🦑", "🦞", "🦀", "🐡", "🐠", "🐟",
            "🐬", "🐳", "🐋", "🦈", "🐊", "🐅", "🐆", "🦓", "🦍", "🦧", "🦣", "🐘", "🦛", "🦏", "🐪", "🐫",
            "🦒", "🦘", "🦬", "🐃", "🐂", "🐄", "🐎", "🐖", "🐏", "🐑", "🦙", "🐐", "🦌", "🐕", "🐩", "🐈",
            "🐓", "🦃", "🦚", "🦩", "🕊️", "🐇", "🦝", "🦨", "🦡", "🦫", "🦦", "🦥", "🐁", "🐀", "🐿️", "🦔",
            "🌵", "🎄", "🌲", "🌳", "🌴", "🌱", "🌿", "☘️", "🍀", "🍁", "🍂", "🍃", "🍄", "🐚", "🪨", "🌾",
            "💐", "🌷", "🌹", "🥀", "🌺", "🌸", "🌼", "🌻", "☀️", "🌤️", "⛅", "🌥️", "☁️", "🌧️", "❄️", "⚡"
        )
        
        val food = listOf(
            "🍇", "🍈", "🍉", "🍊", "🍋", "🍌", "🍍", "🥭", "🍎", "🍏", "🍐", "🍑", "🍒", "🍓", "🫐", "🥝",
            "🍅", "🫒", "🥥", "🥑", "🍆", "🥔", "🥕", "🌽", "🌶️", "🫑", "🥒", "🥬", "🥦", "🧄", "🧅", "🍄",
            "🥜", "🌰", "🍞", "🥐", "🥖", "🫓", "🥨", "🥯", "🥞", "🧇", "🧀", "🍖", "🍗", "🥩", "🥓",
            "🍔", "🍟", "🍕", "🌭", "🥪", "🌮", "🌯", "🥚", "🍳", "🥘", "🍲", "🥣", "🥗", "🍿", "🧈", "🧂",
            "🍱", "🍘", "🍙", "🍚", "🍛", "🍜", "🍝", "🍠", "🍢", "🍣", "🍤", "🍥", "🥮", "🍡", "🥟", "🥠",
            "🥡", "🍦", "🍧", "🍨", "🍩", "🍪", "🎂", "🍰", "🧁", "🥧", "🍫", "🍬", "🍭", "🍮", "🍯", "🍼",
            "🥛", "☕", "🫖", "🍵", "🍶", "🍾", "🍷", "🍸", "🍹", "🍺", "🍻", "🥂", "🥃", "🥤", "🧋", "🧃"
        )
        
        val travel = listOf(
            "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐", "🛻", "🚚", "🚛", "🚜", "🛵", "🏍️",
            "🚲", "🛴", "🚨", "🚂", "🚇", "🚊", "🚉", "🚁", "🛩️", "✈️", "🛫", "🛬", "🛰️", "🚀", "🛸", "⛵",
            "🛶", "🚤", "🚢", "🛥️", "⛴️", "⚓", "🌋", "🏔️", "⛰️", "⛺", "🏕️", "🛖", "🏠", "🏡", "🏢", "🏣",
            "🏤", "🏥", "🏦", "🏨", "🏩", "🏪", "🏫", "🏬", "🏭", "🏯", "🏰", "💒", "🗼", "🗽", "🕌", "⛪",
            "⛩️", "🕍", "⛲", "🎡", "🎢", "🎠", "⛱️", "🏖️", "🏜️", "🏝️", "🏞️", "🏟️", "🗺️", "🗾", "🏔️"
        )
        
        val activities = listOf(
            "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🪀", "🏓", "🏸", "🏒", "🏑", "🥍",
            "🏹", "🏹", "🤿", "🥊", "🥋", "⛸️", "🎿", "🛷", "🥌", "🎯", "🪁", "🎮", "🕹️", "🎰", "🎲", "🧩",
            "🧸", "🎉", "🎊", "🎈", "🎏", "🎀", "🎁", "🧧", "🎟️", "🎫", "🎖️", "🏆", "🥇", "🥈", "🥉", "🏅",
            "🎨", "🎬", "🎤", "🎧", "🎼", "🎹", "🥁", "🪗", "🎸", "🎷", "🎺", "🎻", "🎭", "🎪", "🎫", "🎟️"
        )
        
        val objects = listOf(
            "💡", "🔦", "🕯️", "🪔", "🔌", "🔋", "🛢️", "⛽", "🪙", "💵", "💴", "💶", "💷", "💳", "💎", "⚖️",
            "🔨", "🛠️", "🔧", "⚙️", "🔩", "🧱", "⛓️", "🛡️", "🪓", "🗡️", "⚔️", "🔫", "🏹", "💣", "🧯", "🚬",
            "⚰️", "⚱️", "🏺", "🔮", "🧿", "📿", "💈", "🧲", "🧪", "🧫", "🔬", "🔭", "📡", "🎙️", "📻", "📺",
            "💻", "⌨️", "🖱️", "🖨️", "💾", "💿", "📀", "📽️", "🎬", "🎥", "🎞️", "📷", "📸", "📹", "📼", "🪞"
        )
        
        val symbols = listOf(
            "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❤️‍🩹", "❣️", "💕", "💞", "💓",
            "💗", "💖", "💘", "💝", "💟", "☮️", "✝️", "☪️", "🕉️", "☸️", "✡️", "🔯", "🕎", "☯️", "☦️", "🛐",
            "⛎", "♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓", "🔀", "🔁", "🔂",
            "▶️", "⏩", "⏭️", "⏯️", "◀️", "⏪", "⏮️", "🔼", "🎦", "📶", "📶", "📳", "📴", "➕", "➖", "➗"
        )
        
        val flags = listOf(
            "🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️", "🇨🇳", "🇭🇰", "🇲🇨", "🇹🇼", "🇺🇸", "🇬🇧", "🇯🇵", "🇰🇷",
            "🇫🇷", "🇩🇪", "🇷🇺", "🇮🇹", "🇪🇸", "🇨🇦", "🇦🇺", "🇸🇬", "🇲🇾", "🇹🇭", "🇻🇳", "🇵🇭", "🇮🇩", "🇮🇳", "🇧🇷", "🇿🇦"
        )

        currentEmojis = smileys
        loadFavoriteEmojis()

        binding.rvEmoji.layoutManager = GridLayoutManager(this, 7)
        binding.rvEmoji.adapter = object : RecyclerView.Adapter<ChatEmojiViewHolder>() {
            override fun getItemViewType(position: Int): Int {
                val emoji = currentEmojis[position]
                return if (emoji.startsWith("[img:") && emoji.endsWith("]")) 1 else 0
            }

            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ChatEmojiViewHolder {
                if (viewType == 1) {
                    val iv = android.widget.ImageView(this@ChatActivity).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            (48 * resources.displayMetrics.density).toInt()
                        )
                        scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                        val padding = (6 * resources.displayMetrics.density).toInt()
                        setPadding(padding, padding, padding, padding)
                        val attrs = intArrayOf(android.R.attr.selectableItemBackground)
                        val typedArray = obtainStyledAttributes(attrs)
                        val backgroundResource = typedArray.getResourceId(0, 0)
                        typedArray.recycle()
                        setBackgroundResource(backgroundResource)
                        isClickable = true
                        isLongClickable = true
                        isFocusable = true
                    }
                    return ChatEmojiViewHolder(iv)
                } else {
                    val tv = TextView(this@ChatActivity).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            (48 * resources.displayMetrics.density).toInt()
                        )
                        gravity = Gravity.CENTER
                        textSize = 24f
                        val attrs = intArrayOf(android.R.attr.selectableItemBackground)
                        val typedArray = obtainStyledAttributes(attrs)
                        val backgroundResource = typedArray.getResourceId(0, 0)
                        typedArray.recycle()
                        setBackgroundResource(backgroundResource)
                        isClickable = true
                        isLongClickable = true
                        isFocusable = true
                    }
                    return ChatEmojiViewHolder(tv)
                }
            }

            override fun onBindViewHolder(holder: ChatEmojiViewHolder, position: Int) {
                val emoji = currentEmojis[position]
                if (getItemViewType(position) == 1) {
                    val iv = holder.view as android.widget.ImageView
                    val url = emoji.substring(5, emoji.length - 1)
                    val fullUrl = if (url.startsWith("http")) url else RetrofitClient.getBaseUrl() + url.removePrefix("/")
                    iv.load(fullUrl)
                    iv.setOnClickListener {
                        sendStickerMessage(emoji)
                    }
                    iv.setOnLongClickListener {
                        toggleFavoriteEmoji(emoji)
                        true
                    }
                } else {
                    val tv = holder.view as TextView
                    tv.text = emoji
                    tv.setOnClickListener {
                        val editText = binding.etMessage
                        val start = editText.selectionStart
                        val end = editText.selectionEnd
                        if (start >= 0 && end >= 0) {
                            editText.text.replace(start, end, emoji)
                            editText.setSelection(start + emoji.length)
                        } else {
                            editText.append(emoji)
                        }
                    }
                    tv.setOnLongClickListener {
                        toggleFavoriteEmoji(emoji)
                        true
                    }
                }
            }

            override fun getItemCount(): Int = currentEmojis.size
        }

        val tabs = listOf(
            binding.tabEmojiFavorites to favoriteEmojis,
            binding.tabEmojiSmileys to smileys,
            binding.tabEmojiPeople to people,
            binding.tabEmojiAnimals to animals,
            binding.tabEmojiFood to food,
            binding.tabEmojiTravel to travel,
            binding.tabEmojiActivities to activities,
            binding.tabEmojiObjects to objects,
            binding.tabEmojiSymbols to symbols,
            binding.tabEmojiFlags to flags
        )

        fun selectTab(selectedTab: TextView, categoryEmojis: List<String>) {
            currentEmojis = categoryEmojis
            binding.rvEmoji.adapter?.notifyDataSetChanged()
            
            for (pair in tabs) {
                val tab = pair.first
                if (tab == selectedTab) {
                    tab.setBackgroundColor(android.graphics.Color.parseColor("#E5E7EB"))
                } else {
                    tab.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                }
            }
        }

        // Set initial selection
        selectTab(binding.tabEmojiSmileys, smileys)

        // Bind clicks
        for (pair in tabs) {
            val tab = pair.first
            val emojiList = pair.second
            tab.setOnClickListener {
                selectTab(tab, emojiList)
            }
        }

        binding.btnEmoji.setOnClickListener { toggleEmojiPicker() }
        binding.etMessage.setOnClickListener {
            if (binding.layoutEmojiPicker.visibility == View.VISIBLE) {
                binding.layoutEmojiPicker.visibility = View.GONE
            }
        }
        binding.etMessage.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus && binding.layoutEmojiPicker.visibility == View.VISIBLE) {
                binding.layoutEmojiPicker.visibility = View.GONE
            }
        }
    }

    private fun toggleEmojiPicker() {
        if (binding.layoutEmojiPicker.visibility == View.VISIBLE) {
            binding.layoutEmojiPicker.visibility = View.GONE
            showKeyboard(binding.etMessage)
        } else {
            hideKeyboard()
            binding.layoutEmojiPicker.visibility = View.VISIBLE
        }
    }

    private fun showKeyboard(view: View) {
        view.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideKeyboard() {
        val view = currentFocus ?: View(this)
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(view.windowToken, 0)
    }

    private fun loadFavoriteEmojis() {
        lifecycleScope.launch {
            val result = repository.getFavoriteEmojis()
            result.onSuccess { list ->
                favoriteEmojis.clear()
                favoriteEmojis.addAll(list)
                binding.rvEmoji.adapter?.notifyDataSetChanged()
            }.onFailure { e ->
                android.util.Log.e("ChatActivity", "Failed to load favorites: ${e.message}")
            }
        }
    }

    private fun toggleFavoriteEmoji(emoji: String) {
        val isFavorite = favoriteEmojis.contains(emoji)
        lifecycleScope.launch {
            val result = if (isFavorite) {
                repository.deleteFavoriteEmoji(emoji)
            } else {
                repository.addFavoriteEmoji(emoji)
            }
            result.onSuccess {
                if (isFavorite) {
                    favoriteEmojis.remove(emoji)
                    Toast.makeText(this@ChatActivity, "已取消收藏", Toast.LENGTH_SHORT).show()
                } else {
                    favoriteEmojis.add(emoji)
                    Toast.makeText(this@ChatActivity, "已收藏", Toast.LENGTH_SHORT).show()
                }
                binding.rvEmoji.adapter?.notifyDataSetChanged()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onBackPressed() {
        if (binding.layoutEmojiPicker.visibility == View.VISIBLE) {
            binding.layoutEmojiPicker.visibility = View.GONE
        } else {
            super.onBackPressed()
        }
    }

    private fun sendStickerMessage(sticker: String) {
        val request = SendMessageRequest(
            content = sticker,
            roomId = roomId,
            receiver = targetUser,
            replyTo = null
        )
        lifecycleScope.launch {
            val result = repository.sendMessage(request)
            result.onSuccess {
                loadMessages()
                if (binding.layoutEmojiPicker.visibility == View.VISIBLE) {
                    binding.layoutEmojiPicker.visibility = View.GONE
                }
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "发送失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private class ChatEmojiViewHolder(val view: View) : RecyclerView.ViewHolder(view)

    override fun onDestroy() {
        super.onDestroy()
        WebSocketManager.removeListener(wsListener)
        mainHandler.removeCallbacks(typingTimeoutRunnable)
    }
}
