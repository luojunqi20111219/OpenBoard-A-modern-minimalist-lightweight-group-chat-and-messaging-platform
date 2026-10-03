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
    /** 动态授权标记（服务端 users.is_admin）。未迁移的旧后端不返回该字段 → false */
    @SerializedName("is_admin") val isAdminFlag: Boolean = false,
    /** 站点级禁言的解禁时间，null 表示未被禁言 */
    @SerializedName("muted_until") val mutedUntil: String? = null,
    @SerializedName("created_at") val createdAt: String? = null,
    /** 密码哈希算法标识，如 pbkdf2:sha256:10000 / scrypt:32768:8:1 */
    @SerializedName("password_algorithm") val passwordAlgorithm: String? = null,
    /** true 表示旧格式哈希，当前套餐无法验证，必须重置密码才能登录 */
    @SerializedName("needs_password_reset") val needsPasswordReset: Boolean = false
) {
    val isSystem: Boolean get() = role == 2
    val isBannedBool: Boolean get() = isBanned == 1

    /**
     * 是否具有管理权限。
     *
     * ⚠️ 不要叫 isAdmin —— 那会与 Gson 的字段名 isAdminFlag 在
     * 序列化/反序列化上产生歧义，且与旧的 `isAdmin = role == 1` 计算属性
     * 冲突。这里把两条来源合并：
     *   · role == 1        —— 硬编码时代的最高权限
     *   · isAdminFlag      —— 通过「申请→批准」拿到的动态权限
     * 只看 role 的话，动态管理员在 App 里会显示成「普通用户」。
     */
    val isAdminEffective: Boolean get() = role == 1 || isAdminFlag

    val isMuted: Boolean get() = !mutedUntil.isNullOrBlank()

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
    @SerializedName("action_label") val actionLabel: String? = null,
    /**
     * 管理员用户名列表。
     *
     * 只含用户名（本来就在公开的 /contact-admin 页面上展示），
     * 不含邮箱/手机号等隐私字段。让用户不必打开浏览器就能知道该找谁，
     * 并能直接长按复制对方的名字。
     */
    @SerializedName("admins") val admins: List<String>? = null
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

/**
 * 批准管理员申请。
 *
 * ⚠️ 这里刻意用具名 data class 而不是 `Map<String, Any>`。
 *
 * 之前用的是 Map<String, Any>，运行时抛：
 *   "Parameter type must not include a type variable or wildcard"
 *
 * 原因：Retrofit 需要为 body 找到具体的转换器，而 `Any` 是类型变量/上界，
 * Gson 没有对应的适配器。而且调用方传的是 `Map<String, String>` 或
 * `mapOf<String, Any>(...)` —— Kotlin 泛型**不变**，前者与 `Map<String, Any>`
 * 并非同一类型，编译器只在局部推断通过，到 Retrofit 反射取类型时就炸了。
 *
 * 两个字段都可选（服务端二选一：有 username 用 username，
 * 否则用 request_id 去查），但**至少要给一个**，由服务端校验。
 */
data class AdminDecisionRequest(
    @SerializedName("username") val username: String? = null,
    @SerializedName("request_id") val requestId: Int? = null
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

// ---------------------------------------------------------------------------
// 请求体（具名 data class）
//
// ⚠️ 全部用具名 data class，**不要**用 Map<String, ...>。
//
// 之前有 8 个接口用 Map 当 @Body，运行时抛：
//   "Parameter type must not include a type variable or wildcard"
// 原因：Retrofit 需要为 body 找到具体的转换器，而泛型 Map 的类型参数
// 在反射阶段被擦除成上界，Gson 找不到适配器。而且 Kotlin 泛型**不变**，
// 调用方传 Map<String, String> 与声明 Map<String, Any> 并非同一类型，
// 编译器只在局部推断通过，到反射取类型时才炸 —— 所以这类问题
// 编译期查不出来，只有真机跑到那个接口才暴露。
// ---------------------------------------------------------------------------

/** 只带一个 username 的请求（封禁/解封、删除用户、撤销权限、解除禁言） */
data class UsernameRequest(
    @SerializedName("username") val username: String
)

/** 全站广播 */
data class ContentRequest(
    @SerializedName("content") val content: String
)

/** 只带 group_id 的请求（冻结群聊、删除群聊） */
data class GroupIdRequest(
    @SerializedName("group_id") val groupId: Int
)

/** 撤回消息 */
data class DeleteMessagesRequest(
    @SerializedName("msg_ids") val msgIds: List<Int>
)

/** 提交管理员申请 */
data class AdminApplyRequest(
    @SerializedName("note") val note: String? = null,
    @SerializedName("device_info") val deviceInfo: String? = null
)

/**
 * 站点级禁言。
 *
 * `minutes` 与 `until` 二选一：服务端优先用 minutes 自己算时间。
 * 之所以不建议客户端传 until —— 手机时区不一致会让禁言立即失效
 * 或禁言时长翻倍。until 只在需要精确指定时用。
 */
data class MuteUserRequest(
    @SerializedName("username") val username: String,
    @SerializedName("minutes") val minutes: Int? = null,
    @SerializedName("until") val until: String? = null
)

/** 群内禁言 */
data class MuteGroupMemberRequest(
    @SerializedName("group_id") val groupId: Int,
    @SerializedName("username") val username: String,
    @SerializedName("minutes") val minutes: Int? = null,
    @SerializedName("until") val until: String? = null
)

/** 通用操作结果 */
data class SimpleResult(
    @SerializedName("status") val status: String? = null,
    @SerializedName("msg") val msg: String? = null,
    @SerializedName("detail") val detail: String? = null,
    @SerializedName("is_banned") val isBanned: Int? = null,
    @SerializedName("muted_until") val mutedUntil: String? = null
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
    /**
     * 全局唯一键，形如 "admin:12" / "group:7"。
     *
     * ⚠️ 不要用 id 做 DiffUtil 的 areItemsTheSame —— 审计结果合并了
     * admin_audit_logs 与 group_audit_logs 两张表，两边的 id 各自自增，
     * 合并后必然重复。用 id 判断"是不是同一条"会导致列表项串位、
     * 内容变了却复用旧 ViewHolder（表现为闪烁）。
     */
    @SerializedName("uid") val uid: String? = null,
    /** "admin"（全局管理操作）或 "group"（群内管理操作） */
    @SerializedName("source") val source: String? = null,
    @SerializedName("group_id") val groupId: Int? = null,
    @SerializedName("actor") val actor: String = "",
    @SerializedName("action") val action: String = "",
    @SerializedName("target") val target: String? = null,
    @SerializedName("detail") val detail: String? = null,
    @SerializedName("created_at") val createdAt: String? = null
) {
    /** DiffUtil 用的稳定键；老后端不返回 uid 时退化为 source+id */
    val stableKey: String get() = uid ?: "${source ?: "admin"}:$id"
    val isGroupSource: Boolean get() = source == "group"
}

data class AuditLogResponse(
    @SerializedName("logs") val logs: List<AuditLogItem> = emptyList(),
    @SerializedName("total") val total: Int = 0
)

/** GET /api/admin/migration_status */
data class MigrationStatus(
    @SerializedName("users_is_admin") val usersIsAdmin: Boolean = false,
    @SerializedName("admin_requests") val adminRequests: Boolean = false,
    @SerializedName("admin_audit_logs") val adminAuditLogs: Boolean = false,
    /**
     * 自助重置为默认密码后置 1，改完密码清 0。
     * 老后端不返回该字段 → false。
     */
    @SerializedName("users_must_change_password") val usersMustChangePassword: Boolean = false,
    /** 站点级禁言支持（users.muted_until） */
    @SerializedName("users_muted_until") val usersMutedUntil: Boolean = false,
    /** 数据看板的群新增曲线需要它（groups.created_at） */
    @SerializedName("groups_created_at") val groupsCreatedAt: Boolean = false,
    @SerializedName("ready") val ready: Boolean = false
) {
    /** 缺哪些项 —— 首页提示"需要初始化"时列出具体缺什么 */
    val missing: List<String>
        get() = buildList {
            if (!usersIsAdmin) add("users.is_admin")
            if (!adminRequests) add("admin_requests")
            if (!adminAuditLogs) add("admin_audit_logs")
            if (!usersMustChangePassword) add("users.must_change_password")
            if (!usersMutedUntil) add("users.muted_until")
            if (!groupsCreatedAt) add("groups.created_at")
        }
}

/** POST /api/admin/apply_migrations */
data class MigrationResult(
    @SerializedName("status") val status: String? = null,
    @SerializedName("applied") val applied: List<String> = emptyList(),
    @SerializedName("skipped") val skipped: List<String> = emptyList(),
    @SerializedName("errors") val errors: List<String> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)

// ---------------------------------------------------------------------------
// 数据看板
// ---------------------------------------------------------------------------

/** GET /api/admin/stats/overview */
data class StatsOverviewResponse(
    @SerializedName("users") val users: Int = 0,
    @SerializedName("groups") val groups: Int = 0,
    @SerializedName("messages") val messages: Int = 0,
    @SerializedName("new_users_today") val newUsersToday: Int = 0,
    @SerializedName("new_messages_today") val newMessagesToday: Int = 0,
    @SerializedName("new_groups_today") val newGroupsToday: Int = 0,
    @SerializedName("banned") val banned: Int = 0,
    /** 当前仍生效的禁言数（已过期的不计） */
    @SerializedName("muted") val muted: Int = 0,
    @SerializedName("admins") val admins: Int = 0,
    @SerializedName("online") val online: Int = 0
)

/** GET /api/admin/stats/timeseries 的点 */
data class TimeseriesPoint(
    @SerializedName("d") val date: String = "",
    @SerializedName("n") val count: Int = 0
)

data class TimeseriesResponse(
    @SerializedName("metric") val metric: String? = null,
    @SerializedName("days") val days: Int = 0,
    @SerializedName("points") val points: List<TimeseriesPoint> = emptyList()
)

// ---------------------------------------------------------------------------
// 内容审核
// ---------------------------------------------------------------------------

/** GET /api/admin/search_messages 的消息项 */
data class AuditMessage(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("name") val name: String = "",
    @SerializedName("content") val content: String? = null,
    @SerializedName("room_id") val roomId: Int? = null,
    @SerializedName("receiver") val receiver: String? = null,
    @SerializedName("group_name") val groupName: String? = null,
    @SerializedName("created_at") val createdAt: String? = null,
    @SerializedName("source") val source: String? = null,
    /** 是否已被撤回（内容已替换为 [system_recalled]） */
    @SerializedName("recalled") val recalled: Boolean = false,
    /** 被改过几次 —— >0 时显示「查看历史」入口 */
    @SerializedName("edit_count") val editCount: Int = 0
) {
    /** 会话归属的展示文案 */
    val conversationLabel: String
        get() = when {
            !groupName.isNullOrBlank() -> groupName
            !receiver.isNullOrBlank() -> "私聊 → $receiver"
            roomId != null && roomId > 0 -> "群 #$roomId"
            else -> "未知会话"
        }
}

/** 历史修改命中项 */
data class HistoryMatch(
    @SerializedName("msg_id") val msgId: Int = 0,
    @SerializedName("editor") val editor: String? = null,
    @SerializedName("old_content") val oldContent: String? = null,
    @SerializedName("edited_at") val editedAt: String? = null,
    @SerializedName("source") val source: String? = null
)

data class SearchMessagesResponse(
    @SerializedName("messages") val messages: List<AuditMessage> = emptyList(),
    @SerializedName("total") val total: Int = 0,
    @SerializedName("history_matches") val historyMatches: List<HistoryMatch> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)

/** 版本链里的一环 */
data class MessageVersion(
    @SerializedName("editor") val editor: String? = null,
    @SerializedName("content") val content: String? = null,
    @SerializedName("edited_at") val editedAt: String? = null,
    /** true = 当前生效的版本 */
    @SerializedName("is_current") val isCurrent: Boolean = false
)

data class MessageHistoryResponse(
    @SerializedName("message") val message: AuditMessage? = null,
    @SerializedName("versions") val versions: List<MessageVersion> = emptyList(),
    @SerializedName("detail") val detail: String? = null
)
