package com.openboard.nativeapp.data.model

data class ApiResponse<T>(
    val code: Int = 0,
    val status: String? = null,
    val msg: String? = null,
    val data: T? = null,
    val detail: Any? = null
)
