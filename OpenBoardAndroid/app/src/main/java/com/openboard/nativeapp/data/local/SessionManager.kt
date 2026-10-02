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
    private const val KEY_MUST_CHANGE_PASSWORD = "must_change_password"
    private const val KEY_CAP_SERVER = "cap_server"
    private const val KEY_CAP_URL = "cap_url"
    private const val KEY_CAP_SELF_RESET = "cap_self_reset"
    private const val KEY_CAP_PROBED = "cap_probed"

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
            // 换了服务器 → 之前探测到的能力全部作废。
            // 否则会出现"在 CF 版上探测通过 → 改成普通版地址 → 按钮还在"
            // 这种点了必然失败的残留状态。
            val changed = !finalValue.isNullOrEmpty() && finalValue != prefs.getString(KEY_SERVER_URL, null)
            prefs.edit().putString(KEY_SERVER_URL, finalValue).apply()
            finalValue?.let { RetrofitClient.setBaseUrl(it) }
            if (changed) invalidateCapabilities()
        }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value).apply()
            RetrofitClient.setToken(value)
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

    /**
     * 服务端要求「必须先改密码」。
     *
     * 场景：用户因为旧格式哈希登不上，走自助重置把密码改成了默认密码 12345678。
     * 用这个密码登录成功后服务端下发 must_change_password=true，
     * MainActivity 据此立刻跳强制改密页，不改完不让进主界面 ——
     * 否则所有人都会一直停留在 12345678 这个弱密码上。
     *
     * 持久化是必要的：进程被杀后（或推送把 MainActivity 重新拉起时）
     * 内存标记会丢，而用户还没改密码，必须继续拦。
     * SessionManager.clear() 会一并清掉，不会把标记泄漏到下一次登录。
     */
    var mustChangePassword: Boolean
        get() = prefs.getBoolean(KEY_MUST_CHANGE_PASSWORD, false)
        set(value) = prefs.edit().putBoolean(KEY_MUST_CHANGE_PASSWORD, value).apply()

    // -------------------------------------------------------------------------
    // 服务端能力缓存
    //
    // 探测结果按**服务器地址**缓存：换了服务器地址就必须重新探测，
    // 否则会把"这台支持"的结论用到另一台不支持的服务器上。
    // -------------------------------------------------------------------------

    /**
     * 是否已经针对当前服务器地址探测过能力。
     *
     * 没探测过时调用方应该去探一次，而不是拿默认值当真。
     */
    val capabilitiesProbed: Boolean
        get() = prefs.getBoolean(KEY_CAP_PROBED, false) && prefs.getString(KEY_CAP_URL, null) == serverUrl

    /**
     * 该服务器是否支持「自助重置为默认密码」。
     *
     * **默认 false** —— 没探测过、探测失败、老服务端，一律当作不支持。
     * 这是刻意的保守默认：在不支持的服务器上显示这个按钮，
     * 用户点下去必然失败，体验比"少一个按钮"差得多。
     */
    var supportsSelfReset: Boolean
        get() = capabilitiesProbed && prefs.getBoolean(KEY_CAP_SELF_RESET, false)
        set(value) {
            prefs.edit()
                .putBoolean(KEY_CAP_SELF_RESET, value)
                .putBoolean(KEY_CAP_PROBED, true)
                .putString(KEY_CAP_URL, serverUrl)
                .apply()
        }

    /** 服务端自报的部署形态（cloudflare-workers / fastapi / unknown） */
    var serverKind: String?
        get() = prefs.getString(KEY_CAP_SERVER, null)
        set(value) = prefs.edit().putString(KEY_CAP_SERVER, value).apply()

    /**
     * 换服务器地址时清掉能力缓存。
     *
     * ⚠️ 漏了这一步会出现"在支持的服务上探测成功 → 换成普通服务 →
     *    按钮还在、点了必失败"的情况。
     */
    private fun invalidateCapabilities() {
        prefs.edit()
            .remove(KEY_CAP_SELF_RESET)
            .remove(KEY_CAP_PROBED)
            .remove(KEY_CAP_URL)
            .remove(KEY_CAP_SERVER)
            .apply()
    }

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
    fun isPinned(id: Int, targetUser: String?): Boolean {
        val key = if (targetUser != null) "pinned_user_${targetUser}" else "pinned_group_${id}"
        if (!prefs.contains(key)) {
            if (targetUser == null && id == 0) return true
            if (targetUser == "filehelper") return true
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
        prefs.edit().clear().apply()
        RetrofitClient.setToken(null)
        if (savedServerUrl != null) {
            serverUrl = savedServerUrl
        }
    }
}
