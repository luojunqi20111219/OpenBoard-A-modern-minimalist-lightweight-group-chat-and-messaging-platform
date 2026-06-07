package com.openboard.nativeapp.data.local

import android.content.Context
import android.content.SharedPreferences
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.model.User
import com.openboard.nativeapp.data.model.Conversation

object SessionManager {
    private const val PREFS_NAME = "openboard_prefs"
    private const val KEY_TOKEN = "token"
    private const val KEY_USERNAME = "username"
    private const val KEY_NICKNAME = "nickname"
    private const val KEY_AVATAR = "avatar"
    private const val KEY_CONVERSATIONS = "conversations"
    private const val KEY_SERVER_URL = "server_url"

    private lateinit var prefs: SharedPreferences
    private val gson = com.google.gson.Gson()

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        
        // Load custom Server URL if saved
        val savedServerUrl = prefs.getString(KEY_SERVER_URL, null)
        if (!savedServerUrl.isNullOrEmpty()) {
            RetrofitClient.setBaseUrl(savedServerUrl)
        }
        
        prefs.getString(KEY_TOKEN, null)?.let { RetrofitClient.setToken(it) }
    }

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, "http://liuyan.luojunqi.xyz:5000/")
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, value).apply()
            value?.let { RetrofitClient.setBaseUrl(it) }
        }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value).apply()
            RetrofitClient.setToken(value)
        }

    var username: String?
        get() = prefs.getString(KEY_USERNAME, null)
        set(value) = prefs.edit().putString(KEY_USERNAME, value).apply()

    var nickname: String?
        get() = prefs.getString(KEY_NICKNAME, null)
        set(value) = prefs.edit().putString(KEY_NICKNAME, value).apply()

    var avatar: String?
        get() = prefs.getString(KEY_AVATAR, null)
        set(value) = prefs.edit().putString(KEY_AVATAR, value).apply()

    val isLoggedIn: Boolean
        get() = !token.isNullOrEmpty()

    fun saveUser(user: User) {
        username = user.username
        nickname = user.nickname
        avatar = user.avatar
    }

    fun getUser(): User = User(
        username = username ?: "",
        nickname = nickname,
        avatar = avatar
    )

    fun getConversations(): MutableList<Conversation> {
        val json = prefs.getString(KEY_CONVERSATIONS, null) ?: return mutableListOf()
        val type = object : com.google.gson.reflect.TypeToken<List<Conversation>>() {}.type
        return try {
            gson.fromJson(json, type) ?: mutableListOf()
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    fun saveConversations(list: List<Conversation>) {
        val json = gson.toJson(list)
        prefs.edit().putString(KEY_CONVERSATIONS, json).apply()
    }

    fun updateConversation(
        id: Int,
        targetUser: String?,
        name: String,
        lastMsg: String,
        time: String,
        avatar: String?,
        increaseUnread: Boolean,
        isCurrentChat: Boolean = false,
        createdBy: String? = null
    ) {
        val list = getConversations()
        val index = list.indexOfFirst { it.id == id && it.targetUser == targetUser }

        // Clean up markdown/Base64/recall tags for a premium preview
        val cleanPreview = when {
            lastMsg.contains("[img:") -> "[图片]"
            lastMsg.contains("[file:") -> "[文件]"
            lastMsg == "[system_recalled]" -> "对方撤回了一条消息"
            lastMsg == "[Message recalled]" -> "对方撤回了一条消息"
            else -> lastMsg
        }

        if (index >= 0) {
            val conv = list[index]
            conv.lastMessage = cleanPreview
            conv.time = time
            if (avatar != null) conv.avatar = avatar
            if (createdBy != null) conv.createdBy = createdBy
            if (increaseUnread && !isCurrentChat) {
                conv.unreadCount += 1
            }
            list.removeAt(index)
            list.add(0, conv)
        } else {
            val unread = if (increaseUnread && !isCurrentChat) 1 else 0
            val newConv = Conversation(
                id = id,
                targetUser = targetUser,
                name = name,
                lastMessage = cleanPreview,
                time = time,
                avatar = avatar,
                unreadCount = unread,
                createdBy = createdBy
            )
            list.add(0, newConv)
        }
        saveConversations(list)
    }

    fun clearUnread(id: Int, targetUser: String?) {
        val list = getConversations()
        val index = list.indexOfFirst { it.id == id && it.targetUser == targetUser }
        if (index >= 0) {
            list[index].unreadCount = 0
            saveConversations(list)
        }
    }

    fun clear() {
        prefs.edit().clear().apply()
        RetrofitClient.setToken(null)
    }
}
