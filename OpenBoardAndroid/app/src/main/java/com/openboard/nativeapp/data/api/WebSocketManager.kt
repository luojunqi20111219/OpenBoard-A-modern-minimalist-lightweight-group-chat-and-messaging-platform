package com.openboard.nativeapp.data.api

import android.util.Log
import com.google.gson.Gson
import com.openboard.nativeapp.data.model.WsMessage
import okhttp3.*
import java.util.concurrent.TimeUnit

object WebSocketManager {
    private const val TAG = "WebSocket"
    private const val MAX_RECONNECT = 10

    private var webSocket: WebSocket? = null
    private var isConnected = false
    private var reconnectCount = 0
    private val gson = Gson()
    private val listeners = mutableListOf<WsListener>()

    fun connect() {
        if (isConnected) return
        val client = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()

        val request = Request.Builder()
            .url(RetrofitClient.getWsUrl())
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                isConnected = true
                reconnectCount = 0
                Log.d(TAG, "Connected")
                listeners.forEach { it.onConnected() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.d(TAG, "Message: $text")
                try {
                    val msg = gson.fromJson(text, WsMessage::class.java)
                    listeners.forEach { it.onMessage(msg) }
                } catch (e: Exception) {
                    Log.e(TAG, "Parse error", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "Closing: $code $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                isConnected = false
                Log.d(TAG, "Closed: $code $reason")
                listeners.forEach { it.onDisconnected() }
                tryReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                isConnected = false
                Log.e(TAG, "Error", t)
                listeners.forEach { it.onError(t.message ?: "Unknown error") }
                tryReconnect()
            }
        })
    }

    fun disconnect() {
        reconnectCount = MAX_RECONNECT
        webSocket?.close(1000, "User logout")
        webSocket = null
        isConnected = false
    }

    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    private fun tryReconnect() {
        if (reconnectCount < MAX_RECONNECT) {
            reconnectCount++
            mainHandler.postDelayed({
                connect()
            }, 3000)
        }
    }

    fun send(text: String): Boolean = webSocket?.send(text) == true

    fun addListener(listener: WsListener) { listeners.add(listener) }
    fun removeListener(listener: WsListener) { listeners.remove(listener) }

    interface WsListener {
        fun onConnected() {}
        fun onDisconnected() {}
        fun onError(error: String) {}
        fun onMessage(msg: WsMessage) {}
    }
}
