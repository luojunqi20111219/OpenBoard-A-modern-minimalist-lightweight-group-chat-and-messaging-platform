package com.openboard.nativeapp

import android.app.Application
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.local.SessionManager

class OpenBoardApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
    }
}
