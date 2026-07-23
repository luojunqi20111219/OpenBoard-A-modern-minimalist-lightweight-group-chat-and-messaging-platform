package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * WebSocket 数据广播帧结构
 */
data class WsMessage(
    val type: String? = null,
    val data: WsData? = null,
    val user: String? = null,
    @SerializedName("msg_id")
    val msgId: Int? = null,
    @SerializedName("room_id")
    val roomId: Int? = null,
    val receiver: String? = null,
    val users: List<String>? = null,
    @SerializedName("from_user")
    val fromUser: String? = null,
    @SerializedName("from_nickname")
    val fromNickname: String? = null,
    @SerializedName("from_avatar")
    val fromAvatar: String? = null,
    @SerializedName("by_user")
    val byUser: String? = null,
    @SerializedName("by_nickname")
    val byNickname: String? = null,
    @SerializedName("by_avatar")
    val byAvatar: String? = null,
    val content: String? = null,
    @SerializedName("edited_at")
    val editedAt: String? = null,
    val reader: String? = null,
    @SerializedName("up_to_id")
    val upToId: Int? = null
)

data class WsData(
    val id: Int? = null,
    val content: String? = null,
    val time: String? = null,
    val nickname: String? = null,
    val name: String? = null, // sender username
    val avatar: String? = null,
    @SerializedName("room_id")
    val roomId: Int? = null,
    val receiver: String? = null,
    @SerializedName("reply_to")
    val replyTo: Int? = null,
    @SerializedName("can_recall")
    val canRecall: Boolean = false,
    @SerializedName("client_id")
    val clientId: String? = null,
    @SerializedName("read_count")
    val readCount: Int = 0,
    @SerializedName("can_edit")
    val canEdit: Boolean = false
)
