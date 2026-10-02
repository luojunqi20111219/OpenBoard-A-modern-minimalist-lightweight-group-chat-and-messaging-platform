package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 聊天端用到的管理员授权数据模型。
 *
 * 与专门的管理端 App 里那份是**分开**的：聊天端只需要"申请 + 审批"
 * 这点能力，不需要用户列表、重置密码这些重操作，所以模型也精简到
 * 刚好够用，避免两边字段耦合。
 */

/** GET /api/admin/my_application */
data class MyAdminApplicationResponse(
    @SerializedName("is_admin") val isAdmin: Boolean = false,
    @SerializedName("pending") val pending: PendingApplication? = null,
    @SerializedName("detail") val detail: String? = null
)

data class PendingApplication(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("note") val note: String? = null,
    @SerializedName("created_at") val createdAt: String? = null
)

/** GET /api/admin/requests 的单项 */
data class AdminRequest(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("username") val username: String = "",
    @SerializedName("note") val note: String? = null,
    @SerializedName("status") val status: String = "pending",
    @SerializedName("device_info") val deviceInfo: String? = null,
    @SerializedName("created_at") val createdAt: String? = null,
    @SerializedName("handled_at") val handledAt: String? = null,
    @SerializedName("handled_by") val handledBy: String? = null
)

data class AdminRequestListResponse(
    @SerializedName("requests") val requests: List<AdminRequest> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)

/** GET /api/admin/list 的单项 */
data class AdminEntry(
    @SerializedName("username") val username: String = "",
    @SerializedName("nickname") val nickname: String? = null,
    @SerializedName("avatar") val avatar: String? = null,
    /** true = 服务器配置里的保底管理员，客户端不给「撤销」按钮 */
    @SerializedName("builtin") val builtin: Boolean = false
)

data class AdminListResponse(
    @SerializedName("admins") val admins: List<AdminEntry> = emptyList()
)
