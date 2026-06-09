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
        @Query("target_user") targetUser: String? = null
    ): Call<ApiResponse<List<Message>>>

    @POST("api/messages")
    fun sendMessage(@Body request: SendMessageRequest): Call<ApiResponse<Any>>

    @DELETE("api/messages/{msgId}")
    fun recallMessage(@Path("msgId") msgId: Int): Call<ApiResponse<Any>>

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

    @PUT("api/user/password")
    fun updatePassword(@Body data: Map<String, String>): Call<ApiResponse<Any>>

    @POST("api/user/block")
    fun blockUser(@Body data: Map<String, String>): Call<BlockUserResponse>

    @DELETE("api/user/account")
    fun deleteAccount(): Call<ApiResponse<Any>>

    @POST("api/user/push_token")
    fun uploadPushToken(@Body data: Map<String, String>): Call<ApiResponse<Any>>
}
