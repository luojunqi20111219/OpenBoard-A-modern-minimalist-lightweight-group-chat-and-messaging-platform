package com.openboard.nativeapp.data.api

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.gson.Gson
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.WsMessage
import okhttp3.*

/**
 * WebSocket 管理器，处理长连接生命周期、心跳与重连
 */
object WebSocketManager {
    private const val TAG = "WebSocketManager"
    private val client = OkHttpClient.Builder()
        .pingInterval(30, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    private val gson = Gson()
    private var webSocket: WebSocket? = null
    
    interface WsListener {
        fun onMessage(msg: WsMessage)
    }

    private val listeners = mutableListOf<WsListener>()
    var isConnected = false
    private val handler = Handler(Looper.getMainLooper())
    private val reconnectRunnable = Runnable { connect() }

    fun addListener(l: WsListener) {
        synchronized(listeners) {
            if (!listeners.contains(l)) listeners.add(l)
        }
    }

    fun removeListener(l: WsListener) {
        synchronized(listeners) {
            listeners.remove(l)
        }
    }

    fun connect() {
        val token = SessionManager.token
        if (token.isNullOrEmpty()) {
            Log.w(TAG, "No token found, skipping WS connection")
            return
        }

        disconnect()

        val baseUrl = RetrofitClient.getBaseUrl()
        val wsUrl = when {
            baseUrl.startsWith("https://") -> baseUrl.replace("https://", "wss://")
            baseUrl.startsWith("http://") -> baseUrl.replace("http://", "ws://")
            else -> "ws://$baseUrl"
        } + "ws/$token"

        Log.d(TAG, "Connecting to WebSocket: $wsUrl")
        val request = Request.Builder().url(wsUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "WebSocket connection opened")
                isConnected = true
                handler.removeCallbacks(reconnectRunnable)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.d(TAG, "Received message: $text")
                try {
                    val msg = gson.fromJson(text, WsMessage::class.java)
                    synchronized(listeners) {
                        for (l in listeners) {
                            l.onMessage(msg)
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing WS message: ${e.message}")
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket connection closed: $reason")
                isConnected = false
                triggerReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}")
                isConnected = false
                triggerReconnect()
            }
        })
    }

    fun send(json: String) {
        webSocket?.send(json)
    }

    fun disconnect() {
        handler.removeCallbacks(reconnectRunnable)
        webSocket?.close(1000, "Normal closure")
        webSocket = null
        isConnected = false
    }

    private fun triggerReconnect() {
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, 5000) // 5 秒后尝试重连
    }
}
