package com.openboard.nativeapp.data.model

/**
 * 登录/注册请求的响应实体类
 */
data class AuthResponse(
    val code: Int = 0,
    val token: String? = null,
    val username: String? = null,
    val nickname: String? = null,
    val avatar: String? = null,
    val id: Int = 0,
    val role: Int = 0,
    val msg: String? = null
)
