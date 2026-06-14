package com.openboard.nativeapp.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.huawei.hms.push.HmsMessageService
import com.huawei.hms.push.RemoteMessage
import com.openboard.nativeapp.R
import com.openboard.nativeapp.OpenBoardApp
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.ui.chat.ChatActivity
import com.openboard.nativeapp.ui.login.LoginActivity

/**
 * 华为 HMS 推送服务。
 * 负责接收华为推送的消息、展示状态栏通知，并更新本地会话缓存。
 */
class HmsMessageService : HmsMessageService() {

    companion object {
        private const val TAG = "HmsMessageService"
        private const val CHANNEL_ID = "new_messages"
        private const val NOTIFICATION_ID = 2002
    }

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "新消息通知",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "实时聊天新消息提醒"
                enableLights(true)
                enableVibration(true)
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    override fun onNewToken(token: String?) {
        super.onNewToken(token)
        Log.i(TAG, "Received new HMS token: $token")
        if (!token.isNullOrEmpty()) {
            SessionManager.uploadPushToken(token)
        }
    }

    override fun onMessageReceived(message: RemoteMessage?) {
        super.onMessageReceived(message)
        Log.i(TAG, "HMS message received.")
        if (message == null) return

        val data = message.dataOfMap
        Log.i(TAG, "HMS Data payload: $data")

        if (data["action"] == "logout") {
            Log.i(TAG, "Received force logout command. Clearing session.")
            SessionManager.clear()
            val context = applicationContext
            val intent = Intent(context, LoginActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            context.startActivity(intent)
            return
        }

        val roomId = data["room_id"]?.toIntOrNull() ?: 0
        val sender = data["sender"] ?: "未知"
        val content = data["content"] ?: ""
        val roomName = data["room_name"] ?: ""
        val targetUser = data["target_user"]

        // 更新本地会话列表，保持与 WebSocket 接收数据的一致性
        val isGroup = roomId > 0
        val displayName = if (isGroup) roomName else sender
        
        SessionManager.updateConversation(
            id = roomId,
            targetUser = targetUser,
            name = displayName,
            lastMsg = content,
            time = "刚刚",
            avatar = null,
            increaseUnread = true,
            isCurrentChat = false,
            ownerId = 0
        )

        // 判断应用是否在前台。若在后台，则弹出通知栏及悬浮通知
        val app = application as? OpenBoardApp
        val shouldNotify = app?.isAppInForeground?.not() ?: true
        if (shouldNotify) {
            showNotification(displayName, content, roomId, targetUser)
        }
    }

    private fun showNotification(
        title: String,
        content: String,
        roomId: Int,
        targetUser: String?
    ) {
        val context = applicationContext
        createNotificationChannel(context)

        // 跳转到对应的聊天页面
        val intent = Intent(context, ChatActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("room_id", roomId)
            putExtra("room_name", title)
            targetUser?.let { putExtra("target_user", it) }
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            intent,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            else
                PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_chats)
            .setContentTitle(title)
            .setContentText(content)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }
}
