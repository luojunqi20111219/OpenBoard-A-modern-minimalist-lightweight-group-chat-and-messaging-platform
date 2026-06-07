package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

data class Group(
    val id: Int = 0,
    val name: String = "",
    val description: String? = null,
    @SerializedName("member_count")
    val memberCount: Int = 0,
    @SerializedName("created_by")
    val createdBy: String? = null
)
