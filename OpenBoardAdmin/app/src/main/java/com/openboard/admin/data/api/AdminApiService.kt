package com.openboard.admin.data.api

import com.openboard.admin.data.model.*
import retrofit2.Call
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * 管理端 API。
 *
 * 全部走 /api 前缀，鉴权靠 Authorization 头（见 AdminRetrofitClient）。
 * 服务端对这些接口都挂了 requireAuth + requireAdmin 双重校验，
 * 客户端这边的角色检查只是为了早点给出友好提示，不是安全边界。
 */
interface AdminApiService {

    // -----------------------------------------------------------------------
    // 登录
    // -----------------------------------------------------------------------

    /**
     * 复用普通登录接口。
     *
     * 旧格式哈希（scrypt / 高迭代 pbkdf2）会返回 400 +
     * code=PASSWORD_RESET_REQUIRED，客户端据此提示"需联系管理员"。
     */
    @POST("api/login")
    fun login(@Body request: AdminLoginRequest): Call<AdminLoginResponse>

    // -----------------------------------------------------------------------
    // 用户管理
    // -----------------------------------------------------------------------

    /** 用户列表，支持关键字与分页 */
    @GET("api/admin/users")
    fun listUsers(
        @Query("q") query: String? = null,
        @Query("limit") limit: Int = 100,
        @Query("offset") offset: Int = 0
    ): Call<AdminUserListResponse>

    /** 单个用户详情（含消息数/设备数/登录次数/所在群） */
    @GET("api/admin/user")
    fun userDetail(@Query("username") username: String): Call<UserDetailResponse>

    /** 重置密码 —— 本项目的核心管理能力 */
    @POST("api/admin/reset_password")
    fun resetPassword(@Body request: ResetPasswordRequest): Call<SimpleResult>

    /** 封禁 / 解封（单个用 UsernameRequest 即可） */
    @POST("api/toggle_ban_user")
    fun toggleBan(@Body request: UsernameRequest): Call<SimpleResult>

    /** 批量封禁 / 解封 */
    @POST("api/admin/ban_users")
    fun banUsers(@Body request: BanUsersRequest): Call<BanUsersResponse>

    /** 删除用户（连带清理其消息、好友、群成员关系） */
    @POST("api/admin/delete_user")
    fun deleteUser(@Body request: UsernameRequest): Call<SimpleResult>

    // -----------------------------------------------------------------------
    // 禁言
    //
    // 站点级 vs 群内的区别：站点级在哪都不能发言；群内只在那个群被闭口。
    // 时长一律传 minutes，让服务端算时间 —— 客户端时区不可靠。
    // -----------------------------------------------------------------------

    /** 站点级禁言 */
    @POST("api/admin/mute_user")
    fun muteUser(@Body request: MuteUserRequest): Call<SimpleResult>

    /** 解除站点级禁言 */
    @POST("api/admin/unmute_user")
    fun unmuteUser(@Body request: UsernameRequest): Call<SimpleResult>

    /** 群内禁言 */
    @POST("api/admin/mute_group_member")
    fun muteGroupMember(@Body request: MuteGroupMemberRequest): Call<SimpleResult>

    /** 解除群内禁言 */
    @POST("api/admin/unmute_group_member")
    fun unmuteGroupMember(@Body request: MuteGroupMemberRequest): Call<SimpleResult>

    // -----------------------------------------------------------------------
    // 其他管理操作
    // -----------------------------------------------------------------------

    @GET("api/admin/overview")
    fun overview(): Call<OverviewResponse>

    /** 全站广播 */
    @POST("api/admin/broadcast")
    fun broadcast(@Body request: ContentRequest): Call<SimpleResult>

    /** 冻结 / 解冻群聊 */
    @POST("api/admin/toggle_freeze_group")
    fun toggleFreezeGroup(@Body request: GroupIdRequest): Call<SimpleResult>

    /** 删除群聊 */
    @POST("api/admin/delete_group")
    fun deleteGroup(@Body request: GroupIdRequest): Call<SimpleResult>

    /** 撤回消息（服务端把内容替换为 [system_recalled]） */
    @POST("api/delete_messages")
    fun deleteMessages(@Body request: DeleteMessagesRequest): Call<SimpleResult>

    // -----------------------------------------------------------------------
    // 数据看板
    // -----------------------------------------------------------------------

    /** 总量概览（大数字卡片） */
    @GET("api/admin/stats/overview")
    fun statsOverview(): Call<StatsOverviewResponse>

    /**
     * 按天聚合的时间序列。
     *
     * @param metric users / messages / groups（服务端走白名单校验）
     * @param days   1..90，服务端会夹取
     */
    @GET("api/admin/stats/timeseries")
    fun statsTimeseries(
        @Query("metric") metric: String,
        @Query("days") days: Int = 30
    ): Call<TimeseriesResponse>

    // -----------------------------------------------------------------------
    // 内容审核
    // -----------------------------------------------------------------------

    /**
     * 跨用户消息检索（管理员专属）。
     *
     * 关键字同时匹配消息正文与 message_edits 里的历史原文 ——
     * 后者是为了抓住「发完违规内容再偷偷改掉」这种操作。
     */
    @GET("api/admin/search_messages")
    fun searchMessages(
        @Query("q") query: String? = null,
        @Query("username") username: String? = null,
        @Query("room_id") roomId: Int? = null,
        @Query("receiver") receiver: String? = null,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
        @Query("include_recalled") includeRecalled: Int? = null,
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int = 0
    ): Call<SearchMessagesResponse>

    /** 单条消息的完整版本链（原文 → 每次修改 → 当前） */
    @GET("api/admin/message_history")
    fun messageHistory(@Query("msg_id") msgId: Int): Call<MessageHistoryResponse>

    // -----------------------------------------------------------------------
    // 管理员授权（信任链）
    // -----------------------------------------------------------------------

    /** 提交管理员申请（需登录，不要求已是管理员） */
    @POST("api/admin/apply")
    fun applyAdmin(@Body request: AdminApplyRequest): Call<SimpleResult>

    /** 查询自己的申请状态与当前是否为管理员 */
    @GET("api/admin/my_application")
    fun myApplication(): Call<MyApplicationResponse>

    /** 待审批列表（仅管理员） */
    @GET("api/admin/requests")
    fun listRequests(@Query("status") status: String = "pending"): Call<AdminRequestListResponse>

    /** 批准申请 → 授予管理权限。可传 username 或 request_id */
    @POST("api/admin/approve")
    fun approveAdmin(@Body body: AdminDecisionRequest): Call<SimpleResult>

    /** 拒绝申请 */
    @POST("api/admin/reject")
    fun rejectAdmin(@Body body: AdminDecisionRequest): Call<SimpleResult>

    /** 撤销某人的管理权限 */
    @POST("api/admin/revoke")
    fun revokeAdmin(@Body request: UsernameRequest): Call<SimpleResult>

    /** 当前管理员名单（含硬编码保底名单，builtin=true 不可撤销） */
    @GET("api/admin/list")
    fun listAdmins(): Call<AdminListResponse>

    /**
     * 操作日志（已合并全局管理操作与群内管理操作）。
     *
     * @param actor  按操作者精确筛选
     * @param action 按动作名精确筛选，如 admin.ban
     * @param from   起始日期 'YYYY-MM-DD'（服务端补 00:00:00）
     * @param to     结束日期 'YYYY-MM-DD'（服务端补 23:59:59）
     * @param source all / admin / group
     * @param offset 分页偏移，配合 total 实现"加载更多"
     */
    @GET("api/admin/audit")
    fun auditLogs(
        @Query("actor") actor: String? = null,
        @Query("action") action: String? = null,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
        @Query("source") source: String? = "all",
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int = 0
    ): Call<AuditLogResponse>

    // -----------------------------------------------------------------------
    // 迁移 / 自检
    // -----------------------------------------------------------------------

    /** 迁移状态 —— 首页据此提示"需要初始化" */
    @GET("api/admin/migration_status")
    fun migrationStatus(): Call<MigrationStatus>

    /** 触发管理员相关迁移（幂等） */
    @POST("api/admin/apply_migrations")
    fun applyMigrations(): Call<MigrationResult>
}
