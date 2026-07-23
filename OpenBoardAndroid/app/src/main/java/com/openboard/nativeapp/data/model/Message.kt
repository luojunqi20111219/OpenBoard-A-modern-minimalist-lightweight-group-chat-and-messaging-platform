package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 聊天消息实体类
 */
data class Message(
    val id: Int,
    val name: String,
    val content: String,
    val time: String? = null,
    val nickname: String? = null,
    val avatar: String? = null,
    val reply: String? = null,
    @SerializedName("room_id")
    val roomId: Int = 0,
    val receiver: String? = null,
    val type: Int = 0,
    @SerializedName("can_recall")
    val canRecall: Boolean = false,
    @SerializedName("is_recalled")
    val isRecalled: Int = 0,
    @SerializedName("client_id")
    val clientId: String? = null,
    @SerializedName("edited_at")
    val editedAt: String? = null,
    val edited: Boolean = false,
    @SerializedName("edit_count")
    val editCount: Int = 0,
    @SerializedName("can_edit")
    val canEdit: Boolean = false,
    @SerializedName("edit_expires_in")
    val editExpiresIn: Int = 0,
    @SerializedName("read_count")
    val readCount: Int = 0,
    val deliveryStatus: String? = null
)
