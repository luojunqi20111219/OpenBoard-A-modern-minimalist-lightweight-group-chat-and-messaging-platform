package com.openboard.nativeapp.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.gson.Gson
import com.openboard.nativeapp.OpenBoardApp
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.api.WebSocketManager
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import com.openboard.nativeapp.ui.chat.ChatActivity
import com.openboard.nativeapp.ui.main.MainActivity

/**
 * 后台消息监听服务 (Foreground Service)
 * 负责保持 WebSocket 连接，实时接收消息并在后台或非当前聊天界面时发送通知栏消息
 */
class MessageService : Service() {

    companion object {
        private const val TAG = "MessageService"
        private const val SERVICE_NOTIFICATION_ID = 101
        private const val CHANNEL_SERVICE_ID = "im_service"
        private const val CHANNEL_MESSAGE_ID = "new_messages"
    }

    private var wakeLock: android.os.PowerManager.WakeLock? = null

    private val wsListener = object : WebSocketManager.WsListener {
        override fun onMessage(msg: WsMessage) {
            handleIncomingMessage(msg)
        }
    }

    private val keepAliveReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action
            Log.d(TAG, "KeepAliveReceiver received action: $action")
            if (!WebSocketManager.isConnected && SessionManager.isLoggedIn) {
                Log.d(TAG, "WebSocket is disconnected, reconnecting...")
                WebSocketManager.connect()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "MessageService onCreate")
        
        // 注册 WebSocket 消息监听
        WebSocketManager.addListener(wsListener)
        
        // 尝试建立 WebSocket 连接
        WebSocketManager.connect()

        // 获取 CPU WakeLock 锁，防止休眠
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            wakeLock = powerManager.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "OpenBoard::MessageServiceWakeLock").apply {
                acquire()
            }
            Log.d(TAG, "Successfully acquired CPU WakeLock")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire WakeLock: ${e.message}")
        }

        // 注册系统广播监听以保持长连接和重连
        val filter = android.content.IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_TIME_TICK) // 每分钟一次
            addAction("android.net.conn.CONNECTIVITY_CHANGE") // 网络状态改变
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(keepAliveReceiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                registerReceiver(keepAliveReceiver, filter)
            }
            Log.d(TAG, "Successfully registered keepAliveReceiver")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register keepAliveReceiver: ${e.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "MessageService onStartCommand")
        // 如果服务被异常杀死，系统自动重启该服务
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "MessageService onDestroy")
        // 注销监听
        WebSocketManager.removeListener(wsListener)
        try {
            unregisterReceiver(keepAliveReceiver)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unregister keepAliveReceiver: ${e.message}")
        }
        wakeLock?.let {
            if (it.isHeld) {
                try {
                    it.release()
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to release wakeLock: ${e.message}")
                }
            }
        }
    }



    /**
     * 处理收到的 WebSocket 广播消息
     */
    private fun handleIncomingMessage(msg: WsMessage) {
        val me = SessionManager.username ?: return
        
        if (msg.type == "message" && msg.data != null) {
            val data = msg.data
            val sender = data.name ?: ""
            
            // 忽略自己发送的消息
            if (sender == me) {
                return
            }

            // 忽略黑名单用户的消息
            if (SessionManager.blockedUsers.contains(sender)) {
                Log.d(TAG, "Ignoring message from blocked user: $sender")
                return
            }

            val isGroup = (data.roomId ?: 0) > 0
            val roomId = data.roomId ?: 0
            val target = if (isGroup) null else sender
            val fallbackName = if (isGroup) "群组 #$roomId" else (data.nickname ?: sender)

            // 查找本地已存会话以复用准确名称 (如群聊名称)
            val cachedConv = SessionManager.getConversations().firstOrNull { it.id == roomId && it.targetUser == target }
            val displayName = cachedConv?.name ?: fallbackName
            val ownerId = cachedConv?.ownerId ?: 0

            // 获取应用的前后台状态及当前活跃聊天界面
            val app = application as OpenBoardApp
            val isAppInForeground = app.isAppInForeground
            val activeRoomId = app.activeRoomId
            val activeTargetUser = app.activeTargetUser

            // 判断当前接收的消息是否来自于用户正在开着的聊天窗口
            val isCurrentChat = if (isGroup) {
                activeRoomId == roomId
            } else {
                activeRoomId == 0 && activeTargetUser == sender
            }

            // 更新本地 SessionManager 缓存的会话列表
            SessionManager.updateConversation(
                id = roomId,
                targetUser = target,
                name = displayName,
                lastMsg = data.content ?: "",
                time = data.time ?: "刚刚",
                avatar = if (isGroup) null else data.avatar,
                increaseUnread = true,
                isCurrentChat = isCurrentChat,
                ownerId = ownerId
            )

            // 如果应用在后台，或者处于前台但不在当前的聊天房间，则弹出通知栏及横幅提示
            if (!isAppInForeground || !isCurrentChat) {
                showNewMessageNotification(roomId, displayName, target, data.nickname ?: sender, data.content ?: "", ownerId)
            }

        } else if (msg.type == "recall") {
            // 处理撤回消息通知
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
        } else if (msg.type == "friend_request") {
            val fromUser = msg.fromUser ?: "新用户"
            val fromNickname = msg.fromNickname ?: fromUser
            showFriendRequestNotification(fromUser, fromNickname, "向您发送了好友申请")
        } else if (msg.type == "friend_accepted") {
            val byUser = msg.byUser ?: "好友"
            val byNickname = msg.byNickname ?: byUser
            showFriendRequestNotification(byUser, byNickname, "同意了您的好友申请，现在可以开始聊天了")
        }
    }

    /**
     * 发送新消息通知 (横幅及状态栏通知)
     */
    private fun showNewMessageNotification(
        roomId: Int,
        roomName: String,
        targetUser: String?,
        senderNickname: String,
        content: String,
        ownerId: Int
    ) {
        // 净化展示内容，去除多媒体格式标签
        val cleanText = when {
            content.contains("[img:") -> "[图片]"
            content.contains("[file:") -> "[文件]"
            else -> content
        }

        val title = if (roomId > 0) {
            "$roomName ($senderNickname)"
        } else {
            senderNickname
        }

        // 构建点击通知后的跳转 Intent，直达具体 ChatActivity
        val intent = Intent(this, ChatActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("room_id", roomId)
            putExtra("room_name", roomName)
            targetUser?.let { putExtra("target_user", it) }
            putExtra("owner_id", ownerId)
        }

        // 唯一 RequestCode 避免 PendingIntent 互相覆盖
        var notificationId = if (roomId > 0) roomId else (targetUser?.hashCode() ?: 0)
        if (notificationId == SERVICE_NOTIFICATION_ID) {
            notificationId += 10000
        }

        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            notificationId,
            intent,
            pendingFlags
        )

        // 构建通知 (配置 HIGH 优先级与默认声振以触发屏幕上方 Heads-up 悬浮横幅)
        val builder = NotificationCompat.Builder(this, CHANNEL_MESSAGE_ID)
            .setContentTitle(title)
            .setContentText(cleanText)
            .setSmallIcon(R.drawable.ic_chats)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setCategory(Notification.CATEGORY_MESSAGE)

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(notificationId, builder.build())
    }

    private fun showFriendRequestNotification(username: String, nickname: String, actionText: String) {
        val title = "好友申请"
        val cleanText = "$nickname (@$username) $actionText"

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            username.hashCode(),
            intent,
            pendingFlags
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_MESSAGE_ID)
            .setContentTitle(title)
            .setContentText(cleanText)
            .setSmallIcon(R.drawable.ic_chats)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setCategory(Notification.CATEGORY_SOCIAL)

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(username.hashCode(), builder.build())
    }
}

