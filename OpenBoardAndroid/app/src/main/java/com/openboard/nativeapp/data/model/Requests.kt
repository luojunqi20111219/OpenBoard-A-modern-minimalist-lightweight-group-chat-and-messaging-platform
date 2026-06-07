package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

data class LoginRequest(
    val username: String,
    val password: String
)

data class RegisterRequest(
    val username: String,
    val password: String,
    val nickname: String
)

data class SendMessageRequest(
    val content: String,
    @SerializedName("room_id")
    val roomId: Int = 0,
    @SerializedName("target_user")
    val targetUser: String? = null,
    val reply: String? = null,
    val type: Int = 0,
    @SerializedName("file_url")
    val fileUrl: String? = null,
    @SerializedName("file_type")
    val fileType: String? = null
)

data class CreateGroupRequest(
    val name: String,
    val description: String? = null
)
