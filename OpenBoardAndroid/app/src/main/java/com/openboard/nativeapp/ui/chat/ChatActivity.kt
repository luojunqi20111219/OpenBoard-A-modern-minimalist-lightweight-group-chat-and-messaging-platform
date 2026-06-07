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
        binding.tvTitle.text = roomName
    }

    // 缓存的群设置弹窗实例及待上传的群头像
    private var groupSettingsDialog: AlertDialog? = null
    private var groupSettingsBinding: DialogGroupSettingsBinding? = null
    private var pendingGroupAvatarBase64: String? = null

    // 缓存黑名单状态
    private var isTargetUserBlocked = false

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

        // 解析 Intent 参数
        roomId = intent.getIntExtra("room_id", 0)
        roomName = intent.getStringExtra("room_name") ?: "群聊"
        targetUser = intent.getStringExtra("target_user")
        ownerId = intent.getIntExtra("owner_id", 0)

        setupUI()
        loadMessages()
        checkBlockStatus()

        WebSocketManager.addListener(wsListener)
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
            binding.btnAction.visibility = View.VISIBLE
            binding.btnAction.text = "拉黑"
            binding.btnAction.setOnClickListener { toggleBlockUser() }
        }

        // 初始化 RecyclerView 适配器
        adapter = ChatAdapter(messagesList, myUsername ?: "")
        adapter.onMessageLongClick = { msg -> showMessageOptions(msg) }
        binding.recyclerView.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true // 从底部开始堆叠，符合聊天习惯
        }
        binding.recyclerView.adapter = adapter

        // 附件上传点击
        binding.btnAttach.setOnClickListener {
            currentPickerMode = PickerMode.ATTACHMENT
            pickMediaLauncher.launch("*/*")
        }

        // 发送按钮点击
        binding.btnSend.setOnClickListener { sendMessage() }

        // 输入框变化监听，用于上报“正在输入...”状态
        binding.etMessage.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                triggerTypingIndicator()
            }
            override fun afterTextChanged(s: Editable?) {}
        })
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

        val request = SendMessageRequest(
            content = content,
            roomId = roomId,
            receiver = targetUser
        )

        binding.etMessage.text.clear()

        lifecycleScope.launch {
            val result = repository.sendMessage(request)
            result.onFailure { e ->
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
                    val isImage = mimeType.startsWith("image/")

                    val formattedMsg = if (isImage) {
                        "[img:$url]"
                    } else {
                        "[file:$downloadUrl|$filename]"
                    }

                    // 自动发送附件标签消息
                    repository.sendMessage(
                        SendMessageRequest(
                            content = formattedMsg,
                            roomId = roomId,
                            receiver = targetUser
                        )
                    )
                }.onFailure { e ->
                    Toast.makeText(this@ChatActivity, "文件上传失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                binding.progressBar.visibility = View.GONE
                Toast.makeText(this@ChatActivity, "上传异常: ${e.message}", Toast.LENGTH_SHORT).show()
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
                    val text = if (roomId > 0) "${msg.user} 正在输入..." else "对方正在输入..."
                    binding.tvTitle.text = text
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
        if (message.name == myUsername || isAdmin) {
            options.add("撤回消息")
        }

        if (options.isEmpty()) return

        AlertDialog.Builder(this)
            .setItems(options.toTypedArray()) { _, which ->
                if (options[which] == "撤回消息") {
                    recallMessage(message.id)
                }
            }
            .show()
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

    /**
     * 校验当前聊天的私信对象是否已被拉黑，同步更新按钮样式
     */
    private fun checkBlockStatus() {
        val target = targetUser ?: return
        lifecycleScope.launch {
            val result = repository.getUsersEnvelope()
            result.onSuccess { resp ->
                val blockedList = resp.blockedUsers ?: emptyList()
                SessionManager.blockedUsers = blockedList.toSet()
                isTargetUserBlocked = blockedList.contains(target)
                updateBlockButtonUI()
            }
        }
    }

    /**
     * 拉黑/取消拉黑私聊用户
     */
    private fun toggleBlockUser() {
        val target = targetUser ?: return
        lifecycleScope.launch {
            val result = repository.blockUser(target)
            result.onSuccess { resp ->
                isTargetUserBlocked = resp.isBlocked
                val currentBlocked = SessionManager.blockedUsers.toMutableSet()
                if (isTargetUserBlocked) {
                    currentBlocked.add(target)
                } else {
                    currentBlocked.remove(target)
                }
                SessionManager.blockedUsers = currentBlocked
                updateBlockButtonUI()
                Toast.makeText(
                    this@ChatActivity, 
                    if (isTargetUserBlocked) "已拉黑该用户" else "已取消拉黑", 
                    Toast.LENGTH_SHORT
                ).show()
            }.onFailure { e ->
                Toast.makeText(this@ChatActivity, "拉黑操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun updateBlockButtonUI() {
        binding.btnAction.text = if (isTargetUserBlocked) "已拉黑" else "拉黑"
        if (isTargetUserBlocked) {
            binding.btnAction.setTextColor(resources.getColor(android.R.color.holo_red_light, null))
        } else {
            binding.btnAction.setTextColor(resources.getColor(android.R.color.white, null))
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

    override fun onDestroy() {
        super.onDestroy()
        WebSocketManager.removeListener(wsListener)
        mainHandler.removeCallbacks(typingTimeoutRunnable)
    }
}
