package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 好友申请实体类
 */
data class FriendRequest(
    val id: Int,
    @SerializedName("from_user")
    val fromUser: String,
    val nickname: String?,
    val avatar: String?,
    @SerializedName("created_at")
    val createdAt: String?
)
