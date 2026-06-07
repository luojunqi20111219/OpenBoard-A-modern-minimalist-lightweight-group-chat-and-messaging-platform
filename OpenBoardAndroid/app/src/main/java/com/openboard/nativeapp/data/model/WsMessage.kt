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
    val users: List<String>? = null
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
    val replyTo: Int? = null
)
