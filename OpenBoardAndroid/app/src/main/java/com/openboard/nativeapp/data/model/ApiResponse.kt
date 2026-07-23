package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 统一网络请求响应包装类
 */
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
    val blockedUsers: List<String>? = null,
    val id: Int? = null,
    val pagination: Pagination? = null
)

data class Pagination(
    val limit: Int = 50,
    @SerializedName("has_more")
    val hasMore: Boolean = false,
    @SerializedName("next_before_id")
    val nextBeforeId: Int? = null,
    @SerializedName("last_id")
    val lastId: Int? = null
)
