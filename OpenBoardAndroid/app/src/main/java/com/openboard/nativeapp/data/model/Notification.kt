package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 系统公告/通知数据模型
 */
data class Notification(
    val id: Int,
    val content: String,
    @SerializedName("created_at")
    val createdAt: String,
    val sender: String,
    @SerializedName("target_user")
    val targetUser: String? = null
)
