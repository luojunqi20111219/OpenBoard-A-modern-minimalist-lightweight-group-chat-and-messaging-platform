package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

data class Message(
    val id: Int = 0,
    val name: String = "",
    val content: String = "",
    val time: String? = null,
    val nickname: String? = null,
    val avatar: String? = null,
    val reply: String? = null,
    @SerializedName("room_id")
    val roomId: Int = 0,
    val receiver: String? = null,
    @SerializedName("is_recalled")
    val isRecalled: Int? = null,
    @SerializedName("file_url")
    val fileUrl: String? = null,
    @SerializedName("file_type")
    val fileType: String? = null,
    val type: Int? = null,
    val status: String? = null
)
