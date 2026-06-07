package com.openboard.nativeapp.ui.main

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.databinding.ActivityMainBinding
import com.openboard.nativeapp.ui.chat.ChatActivity
import com.openboard.nativeapp.ui.login.LoginActivity

/**
 * 主 Activity 壳容器，负责 WebSocket 事件的分发和子页面的切换
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding

    interface WsMessageListener {
        fun onWsMessageReceived(msg: WsMessage)
    }

    var recentChatsListener: WsMessageListener? = null

    private val wsListener = object : WebSocketManager.WsListener {
        override fun onMessage(msg: WsMessage) {
            val me = SessionManager.username ?: return
            if (msg.type == "message" && msg.data != null) {
                val data = msg.data
                val isGroup = (data.roomId ?: 0) > 0
                val id = data.roomId ?: 0
                val target = if (isGroup) null else (if (data.name == me) data.receiver else data.name)
                val name = if (isGroup) "群组 #$id" else (if (data.name == me) (data.receiver ?: "聊天") else (data.nickname ?: data.name ?: "聊天"))
                
                SessionManager.updateConversation(
                    id = id,
                    targetUser = target,
                    name = name,
                    lastMsg = data.content ?: "",
                    time = data.time ?: "刚刚",
                    avatar = if (isGroup) null else data.avatar,
                    increaseUnread = true
                )
            } else if (msg.type == "recall") {
                val isGroup = (msg.roomId ?: 0) > 0
                val target = if (isGroup) null else (if (msg.user == me) msg.receiver else msg.user)
                SessionManager.updateConversation(
                    id = msg.roomId ?: 0,
                    targetUser = target,
                    name = if (isGroup) "群组 #${msg.roomId}" else (target ?: "聊天"),
                    lastMsg = "[system_recalled]",
                    time = "刚刚",
                    avatar = null,
                    increaseUnread = false
                )
            }
            runOnUiThread {
                recentChatsListener?.onWsMessageReceived(msg)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (!SessionManager.isLoggedIn) {
            redirectToLogin()
            return
        }

        WebSocketManager.addListener(wsListener)
        WebSocketManager.connect()

        loadFragment(ChatListFragment())
    }

    private fun redirectToLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        WebSocketManager.removeListener(wsListener)
    }

    fun loadFragment(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(binding.fragmentContainer.id, fragment)
            .commit()
    }

    fun navigateToChat(roomId: Int, roomName: String, targetUser: String? = null, ownerId: Int = 0) {
        val intent = Intent(this, ChatActivity::class.java).apply {
            putExtra("room_id", roomId)
            putExtra("room_name", roomName)
            targetUser?.let { putExtra("target_user", it) }
            putExtra("owner_id", ownerId)
        }
        startActivity(intent)
    }

    fun loadUsersList() {
        loadFragment(UsersFragment())
    }

    fun loadGroupsList() {
        loadFragment(GroupsFragment())
    }

    fun logout() {
        SessionManager.clear()
        WebSocketManager.disconnect()
        redirectToLogin()
    }
}
