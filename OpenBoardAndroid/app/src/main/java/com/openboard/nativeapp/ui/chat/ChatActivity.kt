package com.openboard.nativeapp.ui.chat

import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.widget.Toast
import android.widget.EditText
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.Message
import com.openboard.nativeapp.data.model.Group
import com.openboard.nativeapp.data.model.SendMessageRequest
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.ActivityChatBinding
import com.openboard.nativeapp.ui.adapter.ChatAdapter
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody

class ChatActivity : AppCompatActivity() {
    private lateinit var binding: ActivityChatBinding
    private val repository = ChatRepository()
    private lateinit var adapter: ChatAdapter
    private val messages = mutableListOf<Message>()

    private var roomId: Int = 0
    private var roomName: String = "Chat"
    private var targetUser: String? = null
    private var currentGroup: Group? = null

    private var lastTypingSentTime: Long = 0L
    private val typingHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val clearTypingRunnable = Runnable {
        binding.tvTitle.text = roomName
    }

    private val pickFile = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { processFilePick(it) }
    }

    private val wsListener = object : WebSocketManager.WsListener {
        override fun onMessage(msg: WsMessage) {
            runOnUiThread { handleWsMessage(msg) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityChatBinding.inflate(layoutInflater)
        setContentView(binding.root)

        roomId = intent.getIntExtra("room_id", 0)
        roomName = intent.getStringExtra("room_name") ?: "Chat"
        targetUser = intent.getStringExtra("target_user")

        setupUI()
        WebSocketManager.addListener(wsListener)
        loadMessages()
    }

    override fun onResume() {
        super.onResume()
        SessionManager.clearUnread(roomId, targetUser)
    }

    override fun onDestroy() {
        super.onDestroy()
        WebSocketManager.removeListener(wsListener)
        typingHandler.removeCallbacks(clearTypingRunnable)
    }

    private fun setupUI() {
        binding.tvTitle.text = roomName
        binding.btnBack.setOnClickListener { finish() }
        binding.btnSend.setOnClickListener { sendMessage() }
        binding.btnAttach.setOnClickListener { pickFile.launch("*/*") }

        adapter = ChatAdapter(messages, SessionManager.username ?: "")
        binding.recyclerView.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        binding.recyclerView.adapter = adapter

        adapter.onMessageLongClick = { msg ->
            if (msg.name == SessionManager.username) {
                showRecallDialog(msg)
            }
        }

        binding.etMessage.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (!s.isNullOrEmpty()) {
                    sendTypingStatus()
                }
            }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
        setupAction()
    }

    private fun sendTypingStatus() {
        val now = System.currentTimeMillis()
        if (now - lastTypingSentTime > 2500) {
            lastTypingSentTime = now
            val json = com.google.gson.JsonObject().apply {
                addProperty("type", "typing")
                addProperty("room_id", roomId)
                addProperty("receiver", targetUser)
            }.toString()
            WebSocketManager.send(json)
        }
    }

    private fun showTypingIndicator(username: String?) {
        typingHandler.removeCallbacks(clearTypingRunnable)
        if (targetUser != null) {
            binding.tvTitle.text = "$roomName (正在输入...)"
        } else {
            binding.tvTitle.text = "$roomName ($username 正在输入...)"
        }
        typingHandler.postDelayed(clearTypingRunnable, 3000)
    }

    private fun loadMessages() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = if (targetUser != null) {
                repository.getMessages(roomId, targetUser)
            } else {
                repository.getMessages(roomId)
            }
            binding.progressBar.visibility = View.GONE
            result.onSuccess { msgs ->
                messages.clear()
                messages.addAll(msgs)
                adapter.notifyDataSetChanged()
                scrollToBottom()

                if (msgs.isNotEmpty()) {
                    val last = msgs.last()
                    SessionManager.updateConversation(
                        id = roomId,
                        targetUser = targetUser,
                        name = roomName,
                        lastMsg = last.content,
                        time = last.time ?: "刚刚",
                        avatar = if (targetUser != null) last.avatar else null,
                        increaseUnread = false
                    )
                }
            }.onFailure {
                Toast.makeText(this@ChatActivity, "加载消息失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun sendMessage() {
        val content = binding.etMessage.text.toString().trim()
        if (content.isEmpty()) return
        binding.etMessage.text?.clear()

        val msgType = if (targetUser != null) 10 else 12
        val request = SendMessageRequest(
            content = content,
            roomId = roomId,
            targetUser = targetUser,
            type = msgType
        )

        lifecycleScope.launch {
            val result = repository.sendMessage(request)
            result.onSuccess { msg ->
                runOnUiThread {
                    messages.add(msg)
                    adapter.notifyItemInserted(messages.size - 1)
                    scrollToBottom()
                    SessionManager.updateConversation(
                        id = roomId,
                        targetUser = targetUser,
                        name = roomName,
                        lastMsg = msg.content,
                        time = msg.time ?: "刚刚",
                        avatar = if (targetUser != null) msg.avatar else null,
                        increaseUnread = false
                    )
                }
            }.onFailure {
                runOnUiThread {
                    Toast.makeText(this@ChatActivity, "发送失败", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun processFilePick(uri: Uri) {
        val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
        val isImage = mimeType.startsWith("image/")
        if (isImage) {
            binding.progressBar.visibility = View.VISIBLE
            lifecycleScope.launch {
                try {
                    val inputStream = contentResolver.openInputStream(uri) ?: return@launch
                    val originalBytes = inputStream.readBytes()
                    inputStream.close()

                    // Downscale and compress image
                    val bmp = android.graphics.BitmapFactory.decodeByteArray(originalBytes, 0, originalBytes.size)
                    val out = java.io.ByteArrayOutputStream()
                    bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                    val compressedBytes = out.toByteArray()

                    var fileName = "image_${System.currentTimeMillis()}.jpg"
                    contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                        if (nameIndex >= 0 && cursor.moveToFirst()) {
                            val originalName = cursor.getString(nameIndex)
                            if (originalName.isNotEmpty()) {
                                val baseName = originalName.substringBeforeLast(".")
                                fileName = "${baseName}_compressed.jpg"
                            }
                        }
                    }

                    val body = okhttp3.RequestBody.create("image/jpeg".toMediaTypeOrNull(), compressedBytes)
                    val part = MultipartBody.Part.createFormData("file", fileName, body)

                    val uploadResult = repository.uploadFile(part)
                    uploadResult.onSuccess { urlMap ->
                        val fileUrl = urlMap["url"]
                        if (fileUrl != null) {
                            val msgType = if (targetUser != null) 10 else 12
                            val fileContent = "[img:$fileUrl]"
                            val request = SendMessageRequest(
                                content = fileContent,
                                roomId = roomId,
                                targetUser = targetUser,
                                type = msgType
                            )
                            val sendResult = repository.sendMessage(request)
                            binding.progressBar.visibility = View.GONE
                            sendResult.onSuccess { msg ->
                                runOnUiThread {
                                    messages.add(msg)
                                    adapter.notifyItemInserted(messages.size - 1)
                                    scrollToBottom()
                                    SessionManager.updateConversation(
                                        id = roomId,
                                        targetUser = targetUser,
                                        name = roomName,
                                        lastMsg = msg.content,
                                        time = msg.time ?: "刚刚",
                                        avatar = if (targetUser != null) msg.avatar else null,
                                        increaseUnread = false
                                    )
                                }
                            }.onFailure { e ->
                                Toast.makeText(this@ChatActivity, "发送图片消息失败: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        } else {
                            binding.progressBar.visibility = View.GONE
                            Toast.makeText(this@ChatActivity, "上传返回路径为空", Toast.LENGTH_SHORT).show()
                        }
                    }.onFailure { e ->
                        binding.progressBar.visibility = View.GONE
                        Toast.makeText(this@ChatActivity, "上传图片失败: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    binding.progressBar.visibility = View.GONE
                    Toast.makeText(this@ChatActivity, "发送图片失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        } else {
            // Document upload
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: return
                val bytes = inputStream.readBytes()
                inputStream.close()

                var fileName = "file_${System.currentTimeMillis()}"
                contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                    val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && cursor.moveToFirst()) {
                        fileName = cursor.getString(nameIndex)
                    }
                }

                val body = okhttp3.RequestBody.create(mimeType.toMediaTypeOrNull(), bytes)
                val part = MultipartBody.Part.createFormData("file", fileName, body)

                binding.progressBar.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val result = repository.uploadFile(part)
                    binding.progressBar.visibility = View.GONE
                    result.onSuccess { urlMap ->
                        val fileUrl = urlMap["url"]
                        if (fileUrl != null) {
                            val msgType = if (targetUser != null) 10 else 12
                            val fileContent = "[file:$fileUrl|$fileName]"
                            val request = SendMessageRequest(
                                content = fileContent,
                                roomId = roomId,
                                targetUser = targetUser,
                                type = msgType
                            )
                            val sendResult = repository.sendMessage(request)
                            sendResult.onSuccess { msg ->
                                runOnUiThread {
                                    messages.add(msg)
                                    adapter.notifyItemInserted(messages.size - 1)
                                    scrollToBottom()
                                    SessionManager.updateConversation(
                                        id = roomId,
                                        targetUser = targetUser,
                                        name = roomName,
                                        lastMsg = msg.content,
                                        time = msg.time ?: "刚刚",
                                        avatar = if (targetUser != null) msg.avatar else null,
                                        increaseUnread = false
                                    )
                                }
                            }
                        }
                    }.onFailure {
                        runOnUiThread {
                            Toast.makeText(this@ChatActivity, "上传失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            } catch (e: Exception) {
                Toast.makeText(this, "文件读取失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showRecallDialog(msg: Message) {
        AlertDialog.Builder(this)
            .setTitle("撤回消息")
            .setMessage("确定要撤回这条消息吗？")
            .setPositiveButton("撤回") { _, _ -> recallMessage(msg.id) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun recallMessage(msgId: Int) {
        lifecycleScope.launch {
            val result = repository.recallMessage(msgId)
            result.onSuccess {
                runOnUiThread {
                    val index = messages.indexOfFirst { it.id == msgId }
                    if (index >= 0) {
                        val recalled = messages[index].copy(
                            content = "[Message recalled]",
                            isRecalled = 1
                        )
                        messages[index] = recalled
                        adapter.notifyItemChanged(index)
                        
                        SessionManager.updateConversation(
                            id = roomId,
                            targetUser = targetUser,
                            name = roomName,
                            lastMsg = "[system_recalled]",
                            time = "刚刚",
                            avatar = null,
                            increaseUnread = false
                        )
                    }
                }
            }
        }
    }

    private fun handleWsMessage(wsMsg: WsMessage) {
        val me = SessionManager.username ?: return

        if (wsMsg.type == "message" && wsMsg.data != null) {
            val data = wsMsg.data
            val isForMe = when {
                targetUser != null -> {
                    (data.name == targetUser && data.receiver == me) ||
                    (data.name == me && data.receiver == targetUser)
                }
                else -> {
                    data.receiver.isNullOrEmpty() && (data.roomId ?: 0) == roomId
                }
            }

            if (isForMe) {
                val msg = Message(
                    id = data.id ?: System.currentTimeMillis().toInt(),
                    name = data.name ?: "",
                    content = data.content ?: "",
                    time = data.time,
                    nickname = data.nickname,
                    avatar = data.avatar,
                    reply = data.replyTo?.toString(),
                    roomId = data.roomId ?: 0,
                    receiver = data.receiver,
                    type = 512
                )
                messages.add(msg)
                adapter.notifyItemInserted(messages.size - 1)
                scrollToBottom()

                SessionManager.clearUnread(roomId, targetUser)
            }
        } else if (wsMsg.type == "recall") {
            val isForMe = when {
                targetUser != null -> {
                    (wsMsg.user == targetUser && wsMsg.receiver == me) ||
                    (wsMsg.user == me && wsMsg.receiver == targetUser)
                }
                else -> {
                    wsMsg.receiver.isNullOrEmpty() && (wsMsg.roomId ?: 0) == roomId
                }
            }

            if (isForMe) {
                val index = messages.indexOfFirst { it.id == wsMsg.msgId }
                if (index >= 0) {
                    val recalled = messages[index].copy(
                        content = "[Message recalled]",
                        isRecalled = 1
                    )
                    messages[index] = recalled
                    adapter.notifyItemChanged(index)
                }
            }
        } else if (wsMsg.type == "typing") {
            val isForMe = when {
                targetUser != null -> {
                    wsMsg.user == targetUser && wsMsg.receiver == me
                }
                else -> {
                    wsMsg.receiver.isNullOrEmpty() && (wsMsg.roomId ?: 0) == roomId
                }
            }

            if (isForMe && wsMsg.user != me) {
                showTypingIndicator(wsMsg.user)
            }
        }
    }

    private fun scrollToBottom() {
        if (messages.isNotEmpty()) {
            binding.recyclerView.smoothScrollToPosition(messages.size - 1)
        }
    }

    private var isBlocked = false

    private fun checkBlockStatus() {
        lifecycleScope.launch {
            repository.getUsersEnvelope().onSuccess { response ->
                val blocked = response.blockedUsers ?: emptyList()
                isBlocked = blocked.contains(targetUser)
                binding.btnAction.text = if (isBlocked) "取消拉黑" else "拉黑"
            }
        }
    }

    private fun loadGroupDetails() {
        if (roomId > 0) {
            lifecycleScope.launch {
                repository.getGroups().onSuccess { groups ->
                    currentGroup = groups.find { it.id == roomId }
                    currentGroup?.let { group ->
                        val myId = SessionManager.userId
                        if (group.ownerId == myId) {
                            binding.btnAction.visibility = View.VISIBLE
                            binding.btnAction.text = "设置"
                            binding.btnAction.setOnClickListener {
                                showGroupSettingsDialog()
                            }
                        } else {
                            binding.btnAction.visibility = View.GONE
                        }
                    }
                }
            }
        }
    }

    private fun setupAction() {
        val ownerId = intent.getIntExtra("owner_id", 0)
        val myId = SessionManager.userId

        if (targetUser != null) {
            binding.btnAction.visibility = View.VISIBLE
            binding.btnAction.text = "拉黑"
            checkBlockStatus()
            binding.btnAction.setOnClickListener {
                toggleBlock()
            }
        } else if (roomId > 0) {
            if (ownerId == myId && ownerId > 0) {
                binding.btnAction.visibility = View.VISIBLE
                binding.btnAction.text = "设置"
                binding.btnAction.setOnClickListener {
                    showGroupSettingsDialog()
                }
            } else {
                binding.btnAction.visibility = View.GONE
            }
            loadGroupDetails()
        } else {
            binding.btnAction.visibility = View.GONE
        }
    }

    private fun toggleBlock() {
        lifecycleScope.launch {
            val result = repository.blockUser(targetUser!!)
            result.onSuccess { map ->
                val blocked = map["is_blocked"] as? Boolean ?: false
                isBlocked = blocked
                binding.btnAction.text = if (isBlocked) "取消拉黑" else "拉黑"
                Toast.makeText(this@ChatActivity, if (isBlocked) "已拉黑该用户" else "已取消拉黑", Toast.LENGTH_SHORT).show()
            }.onFailure {
                Toast.makeText(this@ChatActivity, "操作失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showGroupSettingsDialog() {
        val options = arrayOf("修改群名", "发言权限", "查看权限", "修改群头像", "解散群组")
        AlertDialog.Builder(this)
            .setTitle("群组设置")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showGroupNameDialog()
                    1 -> showPermissionsDialog(isSpeak = true)
                    2 -> showPermissionsDialog(isSpeak = false)
                    3 -> pickGroupAvatar.launch("image/*")
                    4 -> showDissolveGroupDialog()
                }
            }
            .show()
    }

    private fun showGroupNameDialog() {
        val etName = EditText(this).apply {
            hint = "新的群名称"
            setText(currentGroup?.name ?: roomName)
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
            addView(etName, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        AlertDialog.Builder(this)
            .setTitle("修改群名")
            .setView(layout)
            .setPositiveButton("保存") { _, _ ->
                val newName = etName.text.toString().trim()
                if (newName.isNotEmpty()) {
                    binding.progressBar.visibility = View.VISIBLE
                    lifecycleScope.launch {
                        val result = repository.updateGroup(roomId, newName)
                        binding.progressBar.visibility = View.GONE
                        result.onSuccess {
                            Toast.makeText(this@ChatActivity, "群名更新成功！", Toast.LENGTH_SHORT).show()
                            roomName = newName
                            binding.tvTitle.text = newName
                            currentGroup = currentGroup?.copy(name = newName)
                        }.onFailure { e ->
                            Toast.makeText(this@ChatActivity, "修改失败: ${e.message}", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private val pickGroupAvatar = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { updateGroupAvatar(it) }
    }

    private fun updateGroupAvatar(uri: Uri) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: return@launch
                val bytes = inputStream.readBytes()
                inputStream.close()

                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                val out = java.io.ByteArrayOutputStream()
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                val compressedBytes = out.toByteArray()
                val base64 = Base64.encodeToString(compressedBytes, Base64.NO_WRAP)
                val base64Header = "data:image/jpeg;base64,$base64"

                val result = repository.updateGroupAvatar(roomId, base64Header)
                binding.progressBar.visibility = View.GONE
                result.onSuccess {
                    Toast.makeText(this@ChatActivity, "群头像更新成功！", Toast.LENGTH_SHORT).show()
                }.onFailure {
                    Toast.makeText(this@ChatActivity, "群头像更新失败: ${it.message}", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                binding.progressBar.visibility = View.GONE
                Toast.makeText(this@ChatActivity, "图片读取失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showPermissionsDialog(isSpeak: Boolean) {
        val etMode = EditText(this).apply {
            hint = "模式 (0: 公开, 1: 私有/白名单)"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setText(if (isSpeak) (currentGroup?.speakMode?.toString() ?: "0") else (currentGroup?.viewMode?.toString() ?: "0"))
        }
        val etBlack = EditText(this).apply {
            hint = "黑名单 (用户名，逗号分隔)"
            setText(if (isSpeak) (currentGroup?.blackSpeak ?: "") else (currentGroup?.blackView ?: ""))
        }
        val etWhite = EditText(this).apply {
            hint = "白名单 (用户名，逗号分隔)"
            setText(if (isSpeak) (currentGroup?.whiteSpeak ?: "") else (currentGroup?.whiteView ?: ""))
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
            addView(etMode, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            addView(etBlack, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            addView(etWhite, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        AlertDialog.Builder(this)
            .setTitle(if (isSpeak) "群组发言权限" else "群组查看权限")
            .setView(layout)
            .setPositiveButton("保存") { _, _ ->
                val mode = etMode.text.toString().toIntOrNull() ?: 0
                val black = etBlack.text.toString().trim()
                val white = etWhite.text.toString().trim()

                val permissions = mutableMapOf<String, Any>()
                if (isSpeak) {
                    permissions["speak_mode"] = mode
                    permissions["black_speak"] = black
                    permissions["white_speak"] = white
                } else {
                    permissions["view_mode"] = mode
                    permissions["black_view"] = black
                    permissions["white_view"] = white
                }

                binding.progressBar.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val result = repository.updateGroupPermissions(roomId, permissions)
                    binding.progressBar.visibility = View.GONE
                    result.onSuccess {
                        Toast.makeText(this@ChatActivity, "权限更新成功！", Toast.LENGTH_SHORT).show()
                        currentGroup = if (isSpeak) {
                            currentGroup?.copy(speakMode = mode, blackSpeak = black, whiteSpeak = white)
                        } else {
                            currentGroup?.copy(viewMode = mode, blackView = black, whiteView = white)
                        }
                    }.onFailure {
                        Toast.makeText(this@ChatActivity, "更新失败: ${it.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showDissolveGroupDialog() {
        AlertDialog.Builder(this)
            .setTitle("解散群组")
            .setMessage("您确定要永久解散此群组吗？此操作无法撤销。")
            .setPositiveButton("解散") { _, _ ->
                binding.progressBar.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val result = repository.deleteGroup(roomId)
                    binding.progressBar.visibility = View.GONE
                    result.onSuccess {
                        Toast.makeText(this@ChatActivity, "群组已成功解散", Toast.LENGTH_SHORT).show()
                        finish()
                    }.onFailure {
                        Toast.makeText(this@ChatActivity, "解散失败: ${it.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }
}
