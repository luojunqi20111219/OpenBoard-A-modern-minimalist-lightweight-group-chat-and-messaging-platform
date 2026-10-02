package com.openboard.admin.data.api

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * 管理端网络客户端。
 *
 * 与聊天端的两点差异：
 *  1. token 头格式一致（服务端不过滤 Bearer 前缀），但这里也兼容带前缀的写法
 *  2. 超时更长 —— 删除用户、批量封禁可能涉及多张表的顺序写入
 */
object AdminRetrofitClient {

    /** 默认指向当前部署；登录页可改，便于切测试环境 */
    private const val DEFAULT_BASE_URL = "https://openboard.3270905390.workers.dev/"

    @Volatile private var baseUrl: String = DEFAULT_BASE_URL
    @Volatile private var token: String? = null
    @Volatile private var retrofit: Retrofit? = null

    fun getBaseUrl(): String = baseUrl

    /** 设置服务器地址。会归一化（补尾部斜杠）并在变更时重建 Retrofit */
    @Synchronized
    fun setBaseUrl(url: String) {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) return
        val clean = if (trimmed.endsWith("/")) trimmed else "$trimmed/"
        if (clean != baseUrl) {
            baseUrl = clean
            retrofit = null
        }
    }

    fun setToken(t: String?) {
        token = t?.takeIf { it.isNotBlank() }
    }

    fun getToken(): String? = token

    fun clearToken() {
        token = null
    }

    private fun buildClient(): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            // 只在 debug 构建打日志，release 不打（避免密码进 logcat）
            level = if (com.openboard.admin.BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

        val auth = Interceptor { chain ->
            val builder = chain.request().newBuilder()
            token?.let { builder.addHeader("Authorization", it) }
            chain.proceed(builder.build())
        }

        return OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(auth)
            .addInterceptor(logging)
            .build()
    }

    @Synchronized
    fun api(): AdminApiService {
        var r = retrofit
        if (r == null) {
            r = Retrofit.Builder()
                .baseUrl(baseUrl)
                .client(buildClient())
                .addConverterFactory(GsonConverterFactory.create())
                .build()
            retrofit = r
        }
        // 局部变量 r 在此处已被赋值，但编译器按可空类型推断，显式断言
        return r!!.create(AdminApiService::class.java)
    }
}
