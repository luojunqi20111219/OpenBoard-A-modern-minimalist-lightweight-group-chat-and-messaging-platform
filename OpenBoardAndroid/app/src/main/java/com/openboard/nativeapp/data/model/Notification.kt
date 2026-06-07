package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 对应后端 notifications 表的系统通知/公告数据模型
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
