package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 登录/注册请求的响应实体类
 */
data class AuthResponse(
    val code: Int = 0,
    val token: String? = null,
    val username: String? = null,
    val nickname: String? = null,
    val avatar: String? = null,
    val id: Int = 0,
    val role: Int = 0,
    val msg: String? = null,
    /**
     * 服务端标记「该账号当前用的是自助重置出来的默认密码，必须先改密」。
     *
     * 为 true 时 MainActivity 会立刻跳转到强制改密页，不改完不让进主界面。
     * 老服务端不返回此字段 → 默认 false，行为与之前完全一致。
     */
    @SerializedName("must_change_password") val mustChangePassword: Boolean = false
)

/**
 * 登录失败时的结构化错误体（HTTP 非 2xx 的响应 JSON）。
 *
 * ⚠️ 为什么不直接复用 [AuthResponse]：成功时服务端返回的 `code` 是**数字**
 *    （200），失败时返回的 `code` 是**字符串**（如 `PASSWORD_RESET_REQUIRED`）。
 *    同一个字段两种类型，Gson 反序列化会直接炸，所以必须分开建模。
 *
 * 存在的意义：登录失败有三种完全不同的原因，用户看到的提示必须区分开 ——
 *   1. 密码真的错了          → 401，提示「用户名或密码错误」
 *   2. 账号需要重置密码      → 400 + 本类（code=PASSWORD_RESET_REQUIRED）
 *   3. 账号被封禁            → 403
 * 混在一起会让用户反复重试密码，白白触发登录锁定。
 */
data class AuthErrorResponse(
    /** 面向用户的简短说明 */
    val detail: String? = null,
    /** 机器可读的错误码，如 PASSWORD_RESET_REQUIRED */
    val code: String? = null,
    /** 为什么会这样（比 detail 更具体，可直接展示给用户） */
    val reason: String? = null,
    @SerializedName("admin_contact") val adminContact: AdminContact? = null,
    /** 该密码哈希属于哪个旧算法，如 "scrypt:32768:8:1" */
    @SerializedName("unavailable_since") val unavailableSince: String? = null
)

/**
 * 「请联系管理员」通道 —— 服务端在需要重置密码时一并下发，
 * 客户端据此渲染提示与联系入口。
 */
data class AdminContact(
    val title: String? = null,
    val message: String? = null,
    /** 相对路径，如 /contact-admin；客户端需自行拼上服务器地址 */
    @SerializedName("action_url") val actionUrl: String? = null,
    @SerializedName("action_label") val actionLabel: String? = null,
    /**
     * 是否提供自助重置通道。
     *
     * 为 true 时客户端显示「重置为默认密码」主按钮 —— 用户不需要找任何人，
     * 自己就能把这个账号救活。这是「联系管理员」那句话的替代方案：
     * 因为 admins 里只有站内用户名，用户根本没有站外联系方式可用。
     */
    @SerializedName("self_service") val selfService: Boolean? = null,
    /** 自助重置会用到的默认密码，用于按钮文案与登录框预填 */
    @SerializedName("default_password") val defaultPassword: String? = null,
    /**
     * 管理员用户名列表。
     *
     * 只含用户名（本来就在公开的 /contact-admin 页面上展示），
     * 不含邮箱/手机号等隐私字段。让用户不必打开浏览器就能看到该找谁，
     * 而且能直接复制对方的名字。
     */
    val admins: List<String>? = null
)

