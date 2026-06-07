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
    val createdAt: String? = null
)
