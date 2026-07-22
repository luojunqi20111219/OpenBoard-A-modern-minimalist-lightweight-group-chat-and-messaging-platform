package com.openboard.nativeapp.data.api

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Retrofit 客户端单例，支持动态修改 baseUrl 与登录授权 Token
 */
object RetrofitClient {
    private var baseUrl = "http://47.93.6.111:5000/"
    private var token: String? = null
    private var retrofit: Retrofit? = null

    fun getBaseUrl(): String = baseUrl

    fun setBaseUrl(url: String) {
        val cleanUrl = if (url.endsWith("/")) url else "$url/"
        if (baseUrl != cleanUrl) {
            baseUrl = cleanUrl
            retrofit = null // 强制重新初始化 Retrofit
        }
    }

    fun setToken(t: String?) {
        token = t
    }

    private fun getClient(): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }

        val authInterceptor = object : Interceptor {
            override fun intercept(chain: Interceptor.Chain): Response {
                val req = chain.request().newBuilder()
                token?.let {
                    // 直接传递原始 JWT Token (后端 verify_token 不过滤 'Bearer ' 前缀)
                    req.addHeader("Authorization", it)
                }
                return chain.proceed(req.build())
            }
        }

        return OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(authInterceptor)
            .addInterceptor(logging)
            .build()
    }

    fun getApiService(): ApiService {
        if (retrofit == null) {
            retrofit = Retrofit.Builder()
                .baseUrl(baseUrl)
                .client(getClient())
                .addConverterFactory(GsonConverterFactory.create())
                .build()
        }
        return retrofit!!.create(ApiService::class.java)
    }
}
