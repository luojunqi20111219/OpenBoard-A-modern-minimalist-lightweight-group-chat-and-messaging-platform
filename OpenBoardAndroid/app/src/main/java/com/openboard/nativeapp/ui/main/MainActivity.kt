package com.openboard.nativeapp.ui.main

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.databinding.ActivityMainBinding
import com.openboard.nativeapp.ui.chat.ChatActivity
import android.os.Build
import com.openboard.nativeapp.service.MessageService
import com.openboard.nativeapp.ui.login.LoginActivity
import com.openboard.nativeapp.OpenBoardApp
import com.openboard.nativeapp.ui.theme.ThemeManager

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

        ThemeManager.applyToBottomNav(this, binding.bottomNavigation)

        binding.bottomNavigation.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.menu_chats -> {
                    loadFragment(ChatListFragment())
                    true
                }
                R.id.menu_profile -> {
                    loadFragment(ProfileFragment())
                    true
                }
                else -> false
            }
        }

        WebSocketManager.addListener(wsListener)

        // 请求 Android 13+ 的通知权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 102)
            }
        }

        // 动态申请忽略电池省电优化（保活核心）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
            if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = android.net.Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    android.util.Log.e("MainActivity", "Failed to request ignore battery optimizations: ${e.message}")
                }
            }
        }

        // 启动后台消息监听服务（作为普通后台服务运行，不再显示常驻通知）
        val serviceIntent = Intent(this, MessageService::class.java)
        startService(serviceIntent)

        loadFragment(ChatListFragment())

        // 每次打开应用自动检查更新
        com.openboard.nativeapp.data.update.UpdateManager.checkUpdate(this, isAutoCheck = true)

        // 处理推送通知点击后的跳转
        val pushRoomIdStr = intent.getStringExtra("room_id") ?: intent.getIntExtra("room_id", 0).toString()
        val pushRoomId = pushRoomIdStr.toIntOrNull() ?: 0
        val pushTargetUser = intent.getStringExtra("receiver") ?: intent.getStringExtra("target_user")
        val pushRoomName = intent.getStringExtra("title") ?: intent.getStringExtra("room_name") ?: (if (pushRoomId > 0) "群聊" else (pushTargetUser ?: ""))

        if (pushRoomId > 0 || !pushTargetUser.isNullOrEmpty()) {
            navigateToChat(pushRoomId, pushRoomName, pushTargetUser)
        }
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
            .setCustomAnimations(R.anim.fade_in, R.anim.fade_out)
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
        binding.bottomNavigation.selectedItemId = R.id.menu_chats
    }

    fun loadGroupsList() {
        binding.bottomNavigation.selectedItemId = R.id.menu_chats
    }

    fun logout() {
        // 停止后台消息接收服务
        val serviceIntent = Intent(this, MessageService::class.java)
        stopService(serviceIntent)

        SessionManager.clear()
        WebSocketManager.disconnect()
        redirectToLogin()
    }
}
