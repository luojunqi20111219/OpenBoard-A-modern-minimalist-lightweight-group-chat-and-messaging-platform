package com.openboard.admin.data.model

import com.google.gson.annotations.SerializedName

/**
 * 管理端数据模型。
 *
 * 全部按服务端实际返回的 JSON 字段命名，Gson 反射直接映射。
 * 注意：字段名改动会破坏解析，proguard-rules.pro 里已加了 keep 规则。
 */

/** 通用响应包装：服务端部分接口返回 { status, data }，部分直接返回裸对象 */
data class ApiResponse<T>(
    @SerializedName("status") val status: String? = null,
    @SerializedName("data") val data: T? = null,
    @SerializedName("detail") val detail: String? = null,
    @SerializedName("msg") val msg: String? = null
)

/** GET /api/admin/users 的单项 */
data class AdminUser(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("username") val username: String = "",
    @SerializedName("nickname") val nickname: String? = null,
    @SerializedName("avatar") val avatar: String? = null,
    @SerializedName("role") val role: Int = 0,
    @SerializedName("is_banned") val isBanned: Int = 0,
    @SerializedName("created_at") val createdAt: String? = null,
    /** 密码哈希算法标识，如 pbkdf2:sha256:10000 / scrypt:32768:8:1 */
    @SerializedName("password_algorithm") val passwordAlgorithm: String? = null,
    /** true 表示旧格式哈希，当前套餐无法验证，必须重置密码才能登录 */
    @SerializedName("needs_password_reset") val needsPasswordReset: Boolean = false
) {
    val isAdmin: Boolean get() = role == 1
    val isSystem: Boolean get() = role == 2
    val isBannedBool: Boolean get() = isBanned == 1

    /** 列表里的显示名：优先昵称 */
    val displayName: String get() = nickname?.takeIf { it.isNotBlank() } ?: username
}

/** GET /api/admin/users 的响应 */
data class AdminUserListResponse(
    @SerializedName("users") val users: List<AdminUser> = emptyList(),
    @SerializedName("total") val total: Int = 0,
    @SerializedName("detail") val detail: String? = null
)

/** GET /api/admin/user 的响应 */
data class UserDetailResponse(
    @SerializedName("user") val user: AdminUser? = null,
    @SerializedName("stats") val stats: UserStats? = null,
    @SerializedName("groups") val groups: List<SimpleGroup> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)

data class UserStats(
    @SerializedName("messages") val messages: Int = 0,
    @SerializedName("devices") val devices: Int = 0,
    @SerializedName("logins") val logins: Int = 0,
    @SerializedName("groups") val groups: Int = 0
)

data class SimpleGroup(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("name") val name: String? = null
)

/** 登录请求 / 响应 */
data class AdminLoginRequest(
    @SerializedName("username") val username: String,
    @SerializedName("password") val password: String
)

data class AdminLoginResponse(
    @SerializedName("token") val token: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("nickname") val nickname: String? = null,
    @SerializedName("role") val role: Int? = null,
    @SerializedName("is_admin") val isAdmin: Boolean? = null,
    @SerializedName("detail") val detail: String? = null,
    /** 旧格式哈希专用：PASSWORD_RESET_REQUIRED */
    @SerializedName("code") val code: String? = null,
    @SerializedName("reason") val reason: String? = null,
    @SerializedName("admin_contact") val adminContact: AdminContact? = null
)

data class AdminContact(
    @SerializedName("title") val title: String? = null,
    @SerializedName("message") val message: String? = null,
    @SerializedName("action_url") val actionUrl: String? = null,
    @SerializedName("action_label") val actionLabel: String? = null
)

/** 重置密码请求 */
data class ResetPasswordRequest(
    @SerializedName("username") val username: String,
    @SerializedName("new_password") val newPassword: String
)

/** 封禁 / 解封请求 */
data class BanUsersRequest(
    @SerializedName("usernames") val usernames: List<String>,
    @SerializedName("banned") val banned: Boolean
)

data class BanUsersResponse(
    @SerializedName("status") val status: String? = null,
    @SerializedName("affected") val affected: Int = 0,
    @SerializedName("banned") val banned: Boolean = false,
    @SerializedName("done") val done: List<String> = emptyList(),
    @SerializedName("skipped") val skipped: List<SkippedUser> = emptyList(),
    @SerializedName("msg") val msg: String? = null,
    @SerializedName("detail") val detail: String? = null
)

data class SkippedUser(
    @SerializedName("username") val username: String = "",
    @SerializedName("reason") val reason: String = ""
)

/** 通用操作结果 */
data class SimpleResult(
    @SerializedName("status") val status: String? = null,
    @SerializedName("msg") val msg: String? = null,
    @SerializedName("detail") val detail: String? = null,
    @SerializedName("is_banned") val isBanned: Int? = null
)

/** 概览（管理端首页大数字） */
data class OverviewResponse(
    @SerializedName("users") val users: List<AdminUser> = emptyList(),
    @SerializedName("messages") val messages: List<OverviewMessage> = emptyList(),
    @SerializedName("groups") val groups: List<OverviewGroup> = emptyList(),
    @SerializedName("online") val online: List<String> = emptyList()
)

data class OverviewMessage(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("name") val name: String? = null,
    @SerializedName("content") val content: String? = null,
    @SerializedName("room_id") val roomId: Int = 0,
    @SerializedName("created_at") val createdAt: String? = null
)

data class OverviewGroup(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("name") val name: String? = null,
    @SerializedName("is_public") val isPublic: Int = 0,
    @SerializedName("owner_id") val ownerId: Int = 0,
    @SerializedName("is_frozen") val isFrozen: Int = 0
)

// ---------------------------------------------------------------------------
// 管理员授权相关
// ---------------------------------------------------------------------------

/** GET /api/admin/my_application */
data class MyApplicationResponse(
    @SerializedName("is_admin") val isAdmin: Boolean = false,
    @SerializedName("pending") val pending: PendingApp? = null,
    @SerializedName("detail") val detail: String? = null
)

data class PendingApp(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("note") val note: String? = null,
    @SerializedName("created_at") val createdAt: String? = null
)

/** GET /api/admin/requests 的单项 */
data class AdminRequestItem(
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
    @SerializedName("requests") val requests: List<AdminRequestItem> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)

/** GET /api/admin/list 的单项 */
data class AdminEntry(
    @SerializedName("username") val username: String = "",
    @SerializedName("nickname") val nickname: String? = null,
    @SerializedName("avatar") val avatar: String? = null,
    /** true = 服务器保底名单里的管理员，不可撤销 */
    @SerializedName("builtin") val builtin: Boolean = false
)

data class AdminListResponse(
    @SerializedName("admins") val admins: List<AdminEntry> = emptyList()
)

/** GET /api/admin/audit 的单项 */
data class AuditLogItem(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("actor") val actor: String = "",
    @SerializedName("action") val action: String = "",
    @SerializedName("target") val target: String? = null,
    @SerializedName("detail") val detail: String? = null,
    @SerializedName("created_at") val createdAt: String? = null
)

data class AuditLogResponse(
    @SerializedName("logs") val logs: List<AuditLogItem> = emptyList()
)

/** GET /api/admin/migration_status */
data class MigrationStatus(
    @SerializedName("users_is_admin") val usersIsAdmin: Boolean = false,
    @SerializedName("admin_requests") val adminRequests: Boolean = false,
    @SerializedName("admin_audit_logs") val adminAuditLogs: Boolean = false,
    @SerializedName("ready") val ready: Boolean = false
)

/** POST /api/admin/apply_migrations */
data class MigrationResult(
    @SerializedName("status") val status: String? = null,
    @SerializedName("applied") val applied: List<String> = emptyList(),
    @SerializedName("skipped") val skipped: List<String> = emptyList(),
    @SerializedName("errors") val errors: List<String> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)
