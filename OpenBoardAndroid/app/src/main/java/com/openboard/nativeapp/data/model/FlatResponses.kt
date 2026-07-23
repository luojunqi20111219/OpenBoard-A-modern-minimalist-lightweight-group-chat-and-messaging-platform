package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 文件/图片上传 API 响应结果模型
 */
data class UploadResponse(
    val status: String? = null,
    val url: String? = null,
    val filename: String? = null,
    @SerializedName("download_url")
    val downloadUrl: String? = null,
    @SerializedName("thumbnail_url")
    val thumbnailUrl: String? = null
)

/**
 * 创建群组 API 响应结果模型
 */
data class CreateGroupResponse(
    val status: String? = null,
    @SerializedName("group_id")
    val groupId: Int = 0
)

/**
 * 拉黑/解黑用户 API 响应结果模型
 */
data class BlockUserResponse(
    val status: String? = null,
    val msg: String? = null,
    @SerializedName("is_blocked")
    val isBlocked: Boolean = false
)
