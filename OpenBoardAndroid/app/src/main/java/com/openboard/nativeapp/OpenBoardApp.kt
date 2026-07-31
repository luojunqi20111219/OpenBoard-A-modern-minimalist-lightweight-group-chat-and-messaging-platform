package com.openboard.nativeapp

import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import com.openboard.nativeapp.data.local.SessionManager
import androidx.emoji2.text.EmojiCompat
import androidx.emoji2.bundled.BundledEmojiCompatConfig
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder

/**
 * 自定义 Application 类，在启动时初始化会话管理器、注册 Activity 生命周期回调以跟踪前后台状态，并初始化通知渠道。
 */
class OpenBoardApp : Application(), ImageLoaderFactory {

    // 应用是否在前台运行
    var isAppInForeground: Boolean = false
        private set

    // 当前活跃聊天界面的房间 ID (私聊时为 0, 未处于聊天界面时为 -1)
    var activeRoomId: Int = -1

    // 当前活跃聊天界面的私聊目标用户名 (群聊或未处于聊天界面时为 null)
    var activeTargetUser: String? = null

    private var startedActivityCount = 0

    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)

        // 初始化 EmojiCompat，使用内置的 Bundled 字体库保证所有设备全量渲染最新表情包
        val emojiConfig = BundledEmojiCompatConfig(this)
        EmojiCompat.init(emojiConfig)
        
        // 注册 Activity 生命周期回调以动态感知应用前后台状态
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

            override fun onActivityStarted(activity: Activity) {
                startedActivityCount++
                if (startedActivityCount == 1) {
                    isAppInForeground = true
                }
            }

            override fun onActivityResumed(activity: Activity) {}

            override fun onActivityPaused(activity: Activity) {}

            override fun onActivityStopped(activity: Activity) {
                startedActivityCount--
                if (startedActivityCount == 0) {
                    isAppInForeground = false
                }
            }

            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

            override fun onActivityDestroyed(activity: Activity) {}
        })

        // 创建通知渠道
        createNotificationChannels()
    }

    /**
     * 初始化 Android O+ 所需的通知渠道
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 前台服务常驻通道
            val serviceChannel = NotificationChannel(
                "im_service",
                "后台推送通道",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保持后台实时接收消息服务"
            }

            // 新消息通知通道 (高优先级，支持横幅悬浮)
            val messageChannel = NotificationChannel(
                "new_messages",
                "新消息通知",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "实时聊天新消息提醒"
                enableLights(true)
                lightColor = Color.BLUE
                enableVibration(true)
            }

            val manager = getSystemService(NotificationManager::class.java)
            manager?.let {
                it.createNotificationChannel(serviceChannel)
                it.createNotificationChannel(messageChannel)
            }
        }
    }

    override fun newImageLoader(): ImageLoader {
        return ImageLoader.Builder(this)
            .components {
                if (Build.VERSION.SDK_INT >= 28) {
                    add(ImageDecoderDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            .build()
    }
}
