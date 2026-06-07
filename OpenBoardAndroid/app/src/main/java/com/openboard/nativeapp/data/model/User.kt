package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

data class User(
    val id: Int = 0,
    val username: String = "",
    val nickname: String? = null,
    val avatar: String? = null,
    val bio: String? = null,
    @SerializedName("created_at")
    val createdAt: String? = null
)
