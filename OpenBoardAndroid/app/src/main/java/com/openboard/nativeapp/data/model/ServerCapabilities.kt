package com.openboard.nativeapp.data.model

import com.google.gson.annotations.SerializedName

/**
 * 服务端能力声明（GET /api/capabilities 的响应）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 「自助重置为默认密码」这个功能**只有 Cloudflare Workers 版服务端有**。
 * 普通版（FastAPI）或者老版本的 CF 版都没有这个接口。
 *
 * 如果客户端不问一句就显示按钮，用户在那些服务器上点下去会拿到 404
 * 或者一坨 HTML 错误页 —— 他既不知道发生了什么，也不知道该怎么办。
 *
 * 所以：先探测，确认支持才显示。**探测失败 = 不支持**（默认关闭），
 * 而不是"探测失败也先显示着试试看"。
 *
 * ---------------------------------------------------------------------------
 * 判定规则（客户端必须严格遵守）
 * ---------------------------------------------------------------------------
 *   1. 请求成功 + 响应是合法 JSON + `features.self_reset_password === true`
 *      → 支持
 *   2. 其余一切情况（404 / 超时 / 非 JSON / 字段缺失 / 值为 false）
 *      → 不支持
 *
 * ⚠️ 字段全部可空 + 默认 false：Gson 遇到缺失字段会留 null，
 *    用 `Boolean = false` 的默认值接住，避免拆箱 NPE。
 */
data class ServerCapabilities(
    /** 部署形态：cloudflare-workers / fastapi / unknown */
    val server: String? = null,
    val version: String? = null,
    val features: CapabilityFeatures? = null
) {
    /** 是否支持自助重置为默认密码 —— 决定登录页按钮是否出现 */
    val supportsSelfReset: Boolean
        get() = features?.selfResetPassword == true

    /** 是否会在用默认密码登录后要求强制改密 */
    val supportsForcedPasswordChange: Boolean
        get() = features?.mustChangePassword == true

    /** 是否是 Cloudflare Workers 部署 */
    val isCloudflare: Boolean
        get() = server == "cloudflare-workers"
}

data class CapabilityFeatures(
    @SerializedName("self_reset_password") val selfResetPassword: Boolean? = null,
    @SerializedName("must_change_password") val mustChangePassword: Boolean? = null,
    @SerializedName("admin_grants") val adminGrants: Boolean? = null,
    @SerializedName("legacy_hash_unsupported") val legacyHashUnsupported: Boolean? = null
)
