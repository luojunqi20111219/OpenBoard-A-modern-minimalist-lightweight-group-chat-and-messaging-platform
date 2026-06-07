package com.openboard.nativeapp.data.model

data class Conversation(
    val id: Int, // roomId, or 0 for direct chat
    val targetUser: String?, // username of target for direct chat, null for groups
    val name: String, // nickname/username or group name
    var lastMessage: String,
    var time: String,
    var avatar: String? = null,
    var unreadCount: Int = 0,
    var ownerId: Int = 0
)
