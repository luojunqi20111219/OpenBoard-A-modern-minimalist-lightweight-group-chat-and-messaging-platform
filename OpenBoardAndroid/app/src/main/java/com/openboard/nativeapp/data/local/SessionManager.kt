package com.openboard.nativeapp.data.local

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.model.User
import com.openboard.nativeapp.data.model.Conversation
import com.openboard.nativeapp.data.model.ApiResponse

/**
 * 存放登录信息、缓存的会话列表及服务器地址的本地首选项管理器
 */
object SessionManager {
    private const val PREFS_NAME = "openboard_prefs"
    private const val KEY_TOKEN = "token"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_USERNAME = "username"
    private const val KEY_NICKNAME = "nickname"
    private const val KEY_AVATAR = "avatar"
    private const val KEY_CONVERSATIONS = "conversations"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_ROLE = "role"
    private const val KEY_BLOCKED_USERS = "blocked_users"
    private const val KEY_HMS_TOKEN = "hms_token"

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private val gson = Gson()

    fun init(context: Context) {
        this.context = context.applicationContext
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        
        // 载入保存的自定义服务器地址，并迁移老旧的 http 地址到新的 https 加密通道
        var savedServerUrl = prefs.getString(KEY_SERVER_URL, null)
        if (savedServerUrl != null && savedServerUrl.contains("liuyan.luojunqi.xyz") && savedServerUrl.startsWith("http://")) {
            savedServerUrl = "https://liuyan.luojunqi.xyz/"
            prefs.edit().putString(KEY_SERVER_URL, savedServerUrl).apply()
        }
        
        if (!savedServerUrl.isNullOrEmpty()) {
            RetrofitClient.setBaseUrl(savedServerUrl)
        } else {
            RetrofitClient.setBaseUrl("https://liuyan.luojunqi.xyz/")
        }
        
        prefs.getString(KEY_TOKEN, null)?.let { RetrofitClient.setToken(it) }
    }

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, "https://liuyan.luojunqi.xyz/")
        set(value) {
            var finalValue = value
            if (finalValue != null && finalValue.contains("liuyan.luojunqi.xyz") && finalValue.startsWith("http://")) {
                finalValue = "https://liuyan.luojunqi.xyz/"
            }
            prefs.edit().putString(KEY_SERVER_URL, finalValue).apply()
            finalValue?.let { RetrofitClient.setBaseUrl(it) }
        }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value).apply()
            RetrofitClient.setToken(value)
            if (!value.isNullOrEmpty()) {
                hmsPushToken?.let { uploadPushToken(it) }
            }
        }

    var userId: Int
        get() = prefs.getInt(KEY_USER_ID, 0)
        set(value) = prefs.edit().putInt(KEY_USER_ID, value).apply()

    var username: String?
        get() = prefs.getString(KEY_USERNAME, null)
        set(value) = prefs.edit().putString(KEY_USERNAME, value).apply()

    var nickname: String?
        get() = prefs.getString(KEY_NICKNAME, null)
        set(value) = prefs.edit().putString(KEY_NICKNAME, value).apply()

    var avatar: String?
        get() = prefs.getString(KEY_AVATAR, null)
        set(value) = prefs.edit().putString(KEY_AVATAR, value).apply()

    var role: Int
        get() = prefs.getInt(KEY_ROLE, 0)
        set(value) = prefs.edit().putInt(KEY_ROLE, value).apply()

    val isLoggedIn: Boolean
        get() = !token.isNullOrEmpty()

    fun saveUser(user: User) {
        userId = user.id
        username = user.username
        nickname = user.nickname
        avatar = user.avatar
        role = user.role
    }

    fun getUser(): User = User(
        id = userId,
        username = username ?: "",
        nickname = nickname,
        avatar = avatar,
        role = role
    )

    fun getConversations(): MutableList<Conversation> {
        val json = prefs.getString(KEY_CONVERSATIONS, null) ?: return mutableListOf()
        val type = object : TypeToken<List<Conversation>>() {}.type
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
        ownerId: Int = 0
    ) {
        val list = getConversations()
        val index = list.indexOfFirst { it.id == id && it.targetUser == targetUser }

        // 对消息摘要进行净化，剔除多媒体标签和撤回标识
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
            if (ownerId != 0) conv.ownerId = ownerId
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
                ownerId = ownerId
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

    var blockedUsers: Set<String>
        get() {
            val json = prefs.getString(KEY_BLOCKED_USERS, null) ?: return emptySet()
            val type = object : TypeToken<Set<String>>() {}.type
            return try {
                gson.fromJson(json, type) ?: emptySet()
            } catch (e: Exception) {
                emptySet()
            }
        }
        set(value) {
            val json = gson.toJson(value)
            prefs.edit().putString(KEY_BLOCKED_USERS, json).apply()
        }

    var hmsPushToken: String?
        get() = prefs.getString(KEY_HMS_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_HMS_TOKEN, value).apply()

    fun uploadPushToken(token: String) {
        hmsPushToken = token
        val userToken = this.token
        if (userToken.isNullOrEmpty()) {
            return
        }
        val apiService = RetrofitClient.getApiService()
        val deviceId = android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID) ?: "unknown_device"
        apiService.uploadPushToken(mapOf(
            "push_token" to token,
            "device_id" to deviceId
        )).enqueue(object : retrofit2.Callback<ApiResponse<Any>> {
            override fun onResponse(call: retrofit2.Call<ApiResponse<Any>>, response: retrofit2.Response<ApiResponse<Any>>) {
                if (response.isSuccessful) {
                    android.util.Log.i("SessionManager", "HMS Push Token and Device ID uploaded successfully to server")
                } else {
                    android.util.Log.e("SessionManager", "Failed to upload HMS Push Token: ${response.code()}")
                }
            }
            override fun onFailure(call: retrofit2.Call<ApiResponse<Any>>, t: Throwable) {
                android.util.Log.e("SessionManager", "Error uploading HMS Push Token", t)
            }
        })
    }

    fun isPinned(id: Int, targetUser: String?): Boolean {
        val key = if (targetUser != null) "pinned_user_${targetUser}" else "pinned_group_${id}"
        if (!prefs.contains(key) && targetUser == null && id == 0) {
            return true
        }
        return prefs.getBoolean(key, false)
    }

    fun setPinned(id: Int, targetUser: String?, pinned: Boolean) {
        val key = if (targetUser != null) "pinned_user_${targetUser}" else "pinned_group_${id}"
        prefs.edit().putBoolean(key, pinned).apply()
    }

    fun isPinnedFolded(): Boolean {
        return prefs.getBoolean("pinned_folded", false)
    }

    fun setPinnedFolded(folded: Boolean) {
        prefs.edit().putBoolean("pinned_folded", folded).apply()
    }

    fun clear() {
        val savedServerUrl = serverUrl
        val savedHmsToken = hmsPushToken
        prefs.edit().clear().apply()
        RetrofitClient.setToken(null)
        if (savedServerUrl != null) {
            serverUrl = savedServerUrl
        }
        if (savedHmsToken != null) {
            hmsPushToken = savedHmsToken
        }
    }
}
