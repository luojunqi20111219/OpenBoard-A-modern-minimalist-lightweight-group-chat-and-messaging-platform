package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

data class ApiResponse<T>(
    val code: Int = 0,
    val status: String? = null,
    val msg: String? = null,
    val data: T? = null,
    @SerializedName("detail")
    val detail: Any? = null,
    @SerializedName("last_read_id")
    val lastReadId: Int? = null,
    @SerializedName("blocked_users")
    val blockedUsers: List<String>? = null
)

