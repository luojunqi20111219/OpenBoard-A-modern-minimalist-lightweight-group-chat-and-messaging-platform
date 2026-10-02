package com.openboard.nativeapp.data.api

import com.openboard.nativeapp.data.model.*
import okhttp3.MultipartBody
import retrofit2.Call
import retrofit2.http.*

/**
 * Retrofit API 接口列表
 */
interface ApiService {

    @POST("api/login")
    fun login(@Body request: LoginRequest): Call<AuthResponse>

    @POST("api/register")
    fun register(@Body request: RegisterRequest): Call<AuthResponse>

    @GET("api/messages")
    fun getMessages(
        @Query("room_id") roomId: Int = 0,
        @Query("target_user") targetUser: String? = null,
        @Query("before_id") beforeId: Int? = null,
        @Query("after_id") afterId: Int? = null,
        @Query("limit") limit: Int = 50
    ): Call<ApiResponse<List<Message>>>

    @POST("api/messages")
    fun sendMessage(@Body request: SendMessageRequest): Call<ApiResponse<Any>>

    @DELETE("api/messages/{msgId}")
    fun recallMessage(@Path("msgId") msgId: Int): Call<ApiResponse<Any>>

    @PUT("api/messages/{msgId}")
    fun editMessage(
        @Path("msgId") msgId: Int,
        @Body request: EditMessageRequest
    ): Call<ApiResponse<Any>>

    @POST("api/messages/read")
    fun markMessagesRead(@Body request: MarkReadRequest): Call<ApiResponse<Any>>

    @POST("api/favorites/messages/{msgId}")
    fun favoriteMessage(@Path("msgId") msgId: Int): Call<ApiResponse<Any>>

    @DELETE("api/favorites/messages/{msgId}")
    fun unfavoriteMessage(@Path("msgId") msgId: Int): Call<ApiResponse<Any>>

    @GET("api/messages/search")
    fun searchMessages(
        @Query("q") query: String,
        @Query("room_id") roomId: Int? = null,
        @Query("target_user") targetUser: String? = null,
        @Query("limit") limit: Int = 30
    ): Call<ApiResponse<List<Message>>>

    @GET("api/favorites/messages")
    fun getFavoriteMessages(): Call<ApiResponse<List<Message>>>

    @Multipart
    @POST("api/upload")
    fun uploadFile(@Part file: MultipartBody.Part): Call<UploadResponse>

    @GET("api/users")
    fun getUsers(): Call<ApiResponse<List<User>>>

    @GET("api/groups")
    fun getGroups(): Call<ApiResponse<List<Group>>>

    @POST("api/groups")
    fun createGroup(@Body request: CreateGroupRequest): Call<CreateGroupResponse>

    @PUT("api/groups/{group_id}")
    fun updateGroup(
        @Path("group_id") groupId: Int,
        @Body data: Map<String, String>
    ): Call<ApiResponse<Any>>

    @DELETE("api/groups/{groupId}")
    fun deleteGroup(@Path("groupId") groupId: Int): Call<ApiResponse<Any>>

    @GET("api/notifications")
    fun getNotifications(): Call<ApiResponse<List<Notification>>>

    @POST("api/notifications/read")
    fun markNotificationsRead(): Call<ApiResponse<Any>>

    @POST("api/user/profile")
    fun updateProfile(@Body profile: Map<String, String>): Call<ApiResponse<Any>>

    @PUT("api/groups/{group_id}/permissions")
    fun updateGroupPermissions(
        @Path("group_id") groupId: Int,
        @Body permissions: Map<String, @JvmSuppressWildcards Any>
    ): Call<ApiResponse<Any>>

    @POST("api/groups/{group_id}/avatar")
    fun updateGroupAvatar(
        @Path("group_id") groupId: Int,
        @Body avatar: Map<String, String>
    ): Call<ApiResponse<Any>>

    /**
     * 服务器能力探测。
     *
     * 不需要鉴权 —— 登录页在用户登录前就要用它判断
     * 要不要显示「重置为默认密码」按钮。
     *
     * 老服务端没有这个接口，会返回 404 或 HTML —— 调用方必须把
     * "拿不到 / 解析不了" 一律当作「不支持」，绝不能当成"先试试"。
     */
    @GET("api/capabilities")
    fun getCapabilities(): Call<ServerCapabilities>

    @PUT("api/user/password")
    fun updatePassword(@Body data: Map<String, String>): Call<ApiResponse<Any>>

    /**
     * 自助把密码重置为默认密码 —— 仅对「旧格式哈希、服务器算不动校验」的账号有效。
     *
     * 路径与 authRoutes 内注册的 '/reset-to-default' 对齐（挂在 /api 下）。
     * ⚠️ 它不需要登录态：能走到这一步的用户恰恰是登不上的人。
     */
    @POST("api/reset-to-default")
    fun resetToDefault(@Body data: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/user/block")
    fun blockUser(@Body data: Map<String, String>): Call<BlockUserResponse>

    @DELETE("api/user/account")
    fun deleteAccount(): Call<ApiResponse<Any>>

    @GET("api/check_update")
    fun checkUpdate(): Call<UpdateResponse>

    @GET("api/user/devices")
    fun getUserDevices(): Call<ApiResponse<List<Map<String, Any>>>>

    @POST("api/user/devices/{device_id}/logout")
    fun logoutDevice(@Path("device_id") deviceId: String): Call<ApiResponse<Any>>

    @POST("api/user/logout-all")
    fun logoutAllDevices(@Body data: Map<String, String>): Call<ApiResponse<Any>>

    @GET("api/user/login-history")
    fun getLoginHistory(): Call<ApiResponse<List<Map<String, Any>>>>

    @GET("api/favorites/emojis")
    fun getFavoriteEmojis(): Call<ApiResponse<List<String>>>

    @POST("api/favorites/emojis")
    fun addFavoriteEmoji(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/favorites/emojis/delete")
    fun deleteFavoriteEmoji(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/qr/scan")
    fun scanQrCode(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/qr/authorize")
    fun authorizeQrCode(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @GET("api/friends")
    fun getFriends(): Call<ApiResponse<List<User>>>

    @GET("api/friends/requests")
    fun getFriendRequests(): Call<ApiResponse<List<FriendRequest>>>

    @POST("api/friends/request")
    fun sendFriendRequest(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/friends/add")
    fun addFriendDirectly(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/friends/respond")
    fun respondFriendRequest(@Body request: Map<String, String>): Call<ApiResponse<Any>>

    @GET("api/users/search")
    fun searchUsers(@Query("q") query: String): Call<ApiResponse<List<User>>>

    @DELETE("api/friends/{username}")
    fun removeFriend(@Path("username") username: String): Call<ApiResponse<Any>>

    // =======================================================================
    // 管理员授权 —— 聊天端只做「申请」和「审批」两件事
    //
    // 完整的用户管理（封禁、重置密码、删除）在专门的管理端 App 里，
    // 那边有更合适的交互。聊天端加这几个是因为用户的原话：
    // "授权登录的方式，可以设置为跳转到普通的聊天客户端，然后点击账号"
    // —— 也就是管理员在日常聊天时顺手就能看到并处理申请。
    // =======================================================================

    /** 查询自己是否为管理员 / 有没有待处理申请 */
    @GET("api/admin/my_application")
    fun myAdminApplication(): Call<MyAdminApplicationResponse>

    /** 提交管理员申请（任何登录用户都能调） */
    @POST("api/admin/apply")
    fun applyAdmin(@Body body: Map<String, String>): Call<ApiResponse<Any>>

    /** 待审批列表（管理员才能调） */
    @GET("api/admin/requests")
    fun listAdminRequests(@Query("status") status: String = "pending"): Call<AdminRequestListResponse>

    /** 批准 → 授予管理权限 */
    @POST("api/admin/approve")
    fun approveAdmin(@Body body: Map<String, @JvmSuppressWildcards Any>): Call<ApiResponse<Any>>

    /** 拒绝申请 */
    @POST("api/admin/reject")
    fun rejectAdmin(@Body body: Map<String, @JvmSuppressWildcards Any>): Call<ApiResponse<Any>>

    /** 撤销某人的管理权限 */
    @POST("api/admin/revoke")
    fun revokeAdmin(@Body body: Map<String, String>): Call<ApiResponse<Any>>

    /** 管理员名单（含服务器保底名单，builtin=true 的不可撤销） */
    @GET("api/admin/list")
    fun listAdmins(): Call<AdminListResponse>
}
