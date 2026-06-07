package com.openboard.nativeapp.data.repository

import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.model.*
import okhttp3.MultipartBody
import retrofit2.Call
import retrofit2.Callback
import retrofit2.Response
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class ChatRepository {
    private val api = RetrofitClient.getApiService()

    // Auth calls return AuthResponse directly (no ApiResponse wrapper)
    private suspend fun <T> apiCallRaw(call: () -> Call<T>): Result<T> =
        suspendCancellableCoroutine { cont ->
            val c = call()
            c.enqueue(object : Callback<T> {
                override fun onResponse(retroCall: Call<T>, response: Response<T>) {
                    if (response.isSuccessful && response.body() != null)
                        cont.resume(Result.success(response.body()!!))
                    else
                        cont.resume(Result.failure(Exception("API error: ${response.code()}")))
                }
                override fun onFailure(retroCall: Call<T>, t: Throwable) {
                    cont.resume(Result.failure(t))
                }
            })
            cont.invokeOnCancellation { c.cancel() }
        }

    // Wrapped calls return ApiResponse<T> - check code==200
    private suspend fun <T> apiCallWrapped(call: () -> Call<ApiResponse<T>>): Result<T> =
        suspendCancellableCoroutine { cont ->
            val c = call()
            c.enqueue(object : Callback<ApiResponse<T>> {
                override fun onResponse(retroCall: Call<ApiResponse<T>>, response: Response<ApiResponse<T>>) {
                    val body = response.body()
                    if (response.isSuccessful && body != null && (body.code == 200 || body.status == "success") && body.data != null) {
                        @Suppress("UNCHECKED_CAST")
                        cont.resume(Result.success(body.data as T))
                    } else {
                        cont.resume(Result.failure(Exception("API error: ${response.code()} ${body?.msg ?: ""}")))
                    }
                }
                override fun onFailure(retroCall: Call<ApiResponse<T>>, t: Throwable) {
                    cont.resume(Result.failure(t))
                }
            })
            cont.invokeOnCancellation { c.cancel() }
        }

    // For void/unit API calls (no data expected)
    private suspend fun apiCallVoid(call: () -> Call<ApiResponse<Any>>): Result<Unit> =
        suspendCancellableCoroutine { cont ->
            val c = call()
            c.enqueue(object : Callback<ApiResponse<Any>> {
                override fun onResponse(retroCall: Call<ApiResponse<Any>>, response: Response<ApiResponse<Any>>) {
                    val body = response.body()
                    if (response.isSuccessful && body != null && (body.code == 200 || body.status == "success")) {
                        cont.resume(Result.success(Unit))
                    } else {
                        cont.resume(Result.failure(Exception("API error: ${response.code()} ${body?.msg ?: ""}")))
                    }
                }
                override fun onFailure(retroCall: Call<ApiResponse<Any>>, t: Throwable) {
                    cont.resume(Result.failure(t))
                }
            })
            cont.invokeOnCancellation { c.cancel() }
        }

    suspend fun login(username: String, password: String): Result<AuthResponse> =
        apiCallRaw { api.login(LoginRequest(username, password)) }

    suspend fun register(username: String, password: String, nickname: String): Result<AuthResponse> =
        apiCallRaw { api.register(RegisterRequest(username, password, nickname)) }

    suspend fun getMessages(roomId: Int = 0, targetUser: String? = null): Result<List<Message>> =
        apiCallWrapped { api.getMessages(roomId, targetUser) }

    suspend fun sendMessage(request: SendMessageRequest): Result<Message> =
        apiCallWrapped { api.sendMessage(request) }

    suspend fun recallMessage(msgId: Int): Result<Unit> =
        apiCallVoid { api.recallMessage(msgId) }

    suspend fun uploadFile(file: MultipartBody.Part): Result<Map<String, String>> =
        apiCallWrapped { api.uploadFile(file) }

    suspend fun getUsers(): Result<List<User>> =
        apiCallWrapped { api.getUsers() }

    suspend fun getGroups(): Result<List<Group>> =
        apiCallWrapped { api.getGroups() }

    suspend fun createGroup(name: String, description: String?): Result<Group> =
        apiCallWrapped { api.createGroup(CreateGroupRequest(name, description)) }

    suspend fun deleteGroup(groupId: Int): Result<Unit> =
        apiCallVoid { api.deleteGroup(groupId) }

    suspend fun updateGroupPermissions(groupId: Int, permissions: Map<String, Any>): Result<Unit> =
        apiCallVoid { api.updateGroupPermissions(groupId, permissions) }

    suspend fun updateGroupAvatar(groupId: Int, avatar: String): Result<Unit> =
        apiCallVoid { api.updateGroupAvatar(groupId, mapOf("avatar" to avatar)) }

    suspend fun updatePassword(oldPassword: String, newPassword: String): Result<Unit> =
        apiCallVoid { api.updatePassword(mapOf("old_password" to oldPassword, "new_password" to newPassword)) }

    suspend fun blockUser(targetUsername: String): Result<Map<String, Any>> =
        apiCallWrapped { api.blockUser(mapOf("target_username" to targetUsername)) }

    suspend fun updateProfile(nickname: String, avatar: String?): Result<Unit> {
        val map = mutableMapOf<String, String>()
        map["nickname"] = nickname
        if (avatar != null) map["avatar"] = avatar
        return apiCallVoid { api.updateProfile(map) }
    }

    suspend fun deleteAccount(): Result<Unit> =
        apiCallVoid { api.deleteAccount() }
}
