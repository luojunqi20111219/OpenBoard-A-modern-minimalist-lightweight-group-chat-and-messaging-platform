package com.openboard.nativeapp

import android.app.Application
import com.openboard.nativeapp.data.local.SessionManager

/**
 * 自定义 Application 类，在启动时初始化会话管理器
 */
class OpenBoardApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
    }
}
