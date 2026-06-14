package com.openboard.nativeapp.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.service.MessageService

/**
 * 广播接收器，用于监听设备开机、电量变化等事件，从而自动拉起后台消息接收服务
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.d(TAG, "Received broadcast action: $action")

        if (action == Intent.ACTION_BOOT_COMPLETED || 
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            
            // 初始化 SessionManager，以便读取 token 判定登录状态
            SessionManager.init(context.applicationContext)
            
            if (SessionManager.isLoggedIn) {
                Log.d(TAG, "User is logged in. Relying on HMS Push Kit for background message delivery.")
            } else {
                Log.d(TAG, "User is not logged in, skipping.")
            }
        }
    }
}
