package com.openboard.nativeapp.data.api

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object RetrofitClient {
    private var base_url = "http://liuyan.luojunqi.xyz:5000/"

    private var retrofit: Retrofit? = null
    private var token: String? = null

    fun setBaseUrl(url: String) {
        var cleanUrl = url.trim()
        if (!cleanUrl.endsWith("/")) {
            cleanUrl += "/"
        }
        if (base_url != cleanUrl) {
            base_url = cleanUrl
            retrofit = null // Force recreate
        }
    }

    fun setToken(t: String?) {
        token = t
        retrofit = null // Force recreate
    }

    fun getApiService(): ApiService {
        if (retrofit == null) {
            val logging = HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BODY
            }

            val authInterceptor = Interceptor { chain ->
                val request = chain.request().newBuilder().apply {
                    token?.let { addHeader("Authorization", it) }
                }.build()
                chain.proceed(request)
            }

            val client = OkHttpClient.Builder()
                .addInterceptor(authInterceptor)
                .addInterceptor(logging)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()

            retrofit = Retrofit.Builder()
                .baseUrl(base_url)
                .client(client)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
        }
        return retrofit!!.create(ApiService::class.java)
    }

    fun getWsUrl(): String {
        val base = base_url.replace("http://", "ws://").replace("https://", "wss://")
        val cleanBase = if (base.endsWith("/")) base.substring(0, base.length - 1) else base
        return "$cleanBase/ws/${token ?: ""}"
    }

    fun getBaseUrl(): String = base_url
}
