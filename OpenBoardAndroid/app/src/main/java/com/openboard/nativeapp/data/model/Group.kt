package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

data class Group(
    val id: Int = 0,
    val name: String = "",
    val description: String? = null,
    @SerializedName("owner_id")
    val ownerId: Int = 0,
    val avatar: String? = null,
    @SerializedName("is_public")
    val isPublic: Int = 1,
    @SerializedName("is_frozen")
    val isFrozen: Int = 0,
    @SerializedName("view_mode")
    val viewMode: Int = 0,
    @SerializedName("speak_mode")
    val speakMode: Int = 0,
    @SerializedName("black_view")
    val blackView: String? = "",
    @SerializedName("black_speak")
    val blackSpeak: String? = "",
    @SerializedName("white_view")
    val whiteView: String? = "",
    @SerializedName("white_speak")
    val whiteSpeak: String? = ""
)
