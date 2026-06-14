package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 存放所有的 API 请求体类
 */
data class LoginRequest(
    val username: String,
    val password: String
)

data class RegisterRequest(
    val username: String,
    val password: String,
    val nickname: String? = null
)

data class SendMessageRequest(
    val content: String,
    @SerializedName("room_id")
    val roomId: Int = 0,
    val receiver: String? = null,
    @SerializedName("reply_to")
    val replyTo: Int? = null,
    val type: Int = 0
)

data class CreateGroupRequest(
    val name: String,
    val description: String? = null,
    @SerializedName("is_public")
    val isPublic: Int = 1
)
