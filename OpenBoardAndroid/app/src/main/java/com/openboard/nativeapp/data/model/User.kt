package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 系统用户实体类
 */
data class User(
    val id: Int = 0,
    val username: String = "",
    val nickname: String? = null,
    val avatar: String? = null,
    val bio: String? = null,
    val role: Int = 0,
    @SerializedName("created_at")
    val createdAt: String? = null,
    @SerializedName("is_friend")
    val isFriend: Boolean? = null,
    @SerializedName("request_status")
    val requestStatus: String? = null,
    @SerializedName("request_direction")
    val requestDirection: String? = null
)
