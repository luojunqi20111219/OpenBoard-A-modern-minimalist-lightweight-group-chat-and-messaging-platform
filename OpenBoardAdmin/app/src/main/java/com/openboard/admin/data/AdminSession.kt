package com.openboard.admin.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 管理端会话存储。
 *
 * ⚠️ 只存 token，**绝不存密码**。token 本身有服务端签发与过期时间，
 * 泄露影响面小于密码。若要更严可换 EncryptedSharedPreferences，
 * 但那会引入 security-crypto 依赖并拉高 minSdk，这里是内部工具的折中。
 */
class AdminSession(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var token: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(v) = sp.edit().putString(KEY_TOKEN, v).apply()

    var username: String?
        get() = sp.getString(KEY_USERNAME, null)
        set(v) = sp.edit().putString(KEY_USERNAME, v).apply()

    var nickname: String?
        get() = sp.getString(KEY_NICKNAME, null)
        set(v) = sp.edit().putString(KEY_NICKNAME, v).apply()

    /** 服务器地址，允许在登录页修改以便切测试环境 */
    var baseUrl: String?
        get() = sp.getString(KEY_BASE_URL, null)
        set(v) = sp.edit().putString(KEY_BASE_URL, v).apply()

    val isLoggedIn: Boolean get() = !token.isNullOrBlank()

    fun clear() {
        // 保留 baseUrl —— 用户切换环境的偏好不该因为退出登录而丢失
        val keep = baseUrl
        sp.edit().clear().apply()
        if (keep != null) baseUrl = keep
    }

    companion object {
        private const val PREFS = "openboard_admin_session"
        private const val KEY_TOKEN = "token"
        private const val KEY_USERNAME = "username"
        private const val KEY_NICKNAME = "nickname"
        private const val KEY_BASE_URL = "base_url"
    }
}
