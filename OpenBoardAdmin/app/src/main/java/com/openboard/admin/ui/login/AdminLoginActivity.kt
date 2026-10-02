package com.openboard.admin.ui.login

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.openboard.admin.R
import com.openboard.admin.data.AdminSession
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.AdminLoginRequest
import com.openboard.admin.data.model.AdminLoginResponse
import com.openboard.admin.databinding.ActivityAdminLoginBinding
import com.openboard.admin.ui.main.AdminMainActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import retrofit2.Response

/**
 * 管理端登录页。
 *
 * 与其他页面不同，这里要处理三类结果：
 *   1. 成功且是管理员            → 进主界面
 *   2. 成功但不是管理员          → 提示并提供「申请成为管理员」
 *   3. 旧格式哈希无法验证         → 引导联系已有管理员（不提供申请，因为
 *                                 连自己密码都验证不了，申请也没法处理）
 */
class AdminLoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityAdminLoginBinding
    private lateinit var session: AdminSession

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAdminLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)
        session = AdminSession(this)

        // 恢复上次用的服务器地址
        session.baseUrl?.let { binding.etServer.setText(it) }

        binding.tvToggleServer.setOnClickListener {
            val show = binding.tilServer.visibility != View.VISIBLE
            binding.tilServer.visibility = if (show) View.VISIBLE else View.GONE
            binding.tvToggleServer.text = if (show) "服务器设置 ▴" else "服务器设置 ▾"
        }

        binding.btnLogin.setOnClickListener { doLogin() }

        binding.etPassword.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { doLogin(); true } else false
        }

        binding.btnApply.setOnClickListener { doApply() }

        binding.btnContact.setOnClickListener {
            // 用系统浏览器打开联系管理员页面 —— 比在 App 里内嵌 WebView 更简单，
            // 也方便用户直接复制信息发给管理员
            val url = AdminRetrofitClient.getBaseUrl().trimEnd('/') + "/contact-admin"
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: Exception) {
                Toast.makeText(this, "无法打开浏览器：$url", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        binding.progress.visibility = if (busy) View.VISIBLE else View.GONE
        binding.btnLogin.isEnabled = !busy
        binding.btnLogin.text = if (busy) "登录中…" else "登录"
    }

    private fun showMessage(text: String, showApply: Boolean = false, showContact: Boolean = false) {
        binding.tvMessage.visibility = View.VISIBLE
        binding.tvMessage.text = text
        binding.btnApply.visibility = if (showApply) View.VISIBLE else View.GONE
        binding.btnContact.visibility = if (showContact) View.VISIBLE else View.GONE
    }

    private fun hideMessage() {
        binding.tvMessage.visibility = View.GONE
        binding.btnApply.visibility = View.GONE
        binding.btnContact.visibility = View.GONE
        binding.tvAdminNames.visibility = View.GONE
    }

    private fun doLogin() {
        val username = binding.etUsername.text?.toString()?.trim().orEmpty()
        val password = binding.etPassword.text?.toString().orEmpty()
        val server = binding.etServer.text?.toString()?.trim().orEmpty()

        if (username.isEmpty() || password.isEmpty()) {
            showMessage("请填写账号和密码")
            return
        }
        if (server.isNotEmpty()) {
            AdminRetrofitClient.setBaseUrl(server)
            session.baseUrl = AdminRetrofitClient.getBaseUrl()
        }

        hideMessage()
        setBusy(true)

        lifecycleScope.launch {
            // 分开拿 response 与异常：原来用 Triple 解构是多余的，
            // 而且 Triple 是空类型推断会出错
            var resp: Response<AdminLoginResponse>? = null
            var err: String? = null
            withContext(Dispatchers.IO) {
                try {
                    resp = AdminRetrofitClient.api()
                        .login(AdminLoginRequest(username, password))
                        .execute()
                } catch (ex: Exception) {
                    err = ex.message
                }
            }

            setBusy(false)

            val r = resp
            if (r == null) {
                showMessage("网络错误：${err ?: "未知"}\n请检查服务器地址与网络连接", showContact = true)
                return@launch
            }

            if (r.isSuccessful) {
                val body = r.body()
                val token = body?.token
                if (token.isNullOrBlank()) {
                    showMessage("服务器未返回登录凭证，请稍后重试")
                    return@launch
                }
                session.token = token
                session.username = body.username ?: username
                session.nickname = body.nickname
                AdminRetrofitClient.setToken(token)

                // 是否管理员 —— 服务端返回 is_admin 优先，没有则退回 role==1
                val isAdmin = body.isAdmin == true || body.role == 1
                if (isAdmin) {
                    startActivity(Intent(this@AdminLoginActivity, AdminMainActivity::class.java))
                    finish()
                } else {
                    showMessage(
                        "登录成功，但该账号没有管理权限。\n请在聊天端让现有管理员为你授权，或直接提交申请。",
                        showApply = true,
                    )
                }
                return@launch
            }

            // ---- 失败分支 ----
            val body = parseError(r)
            when (body?.code) {
                "PASSWORD_RESET_REQUIRED" -> {
                    // 密码没输错，是旧版哈希算不动 —— 必须联系管理员重置。
                    // 文案与聊天端 LoginActivity 保持一致，两端同一个说法，
                    // 免得用户在不同 App 里看到两套解释。
                    val reason = body.reason ?: "该账号的密码为旧版格式，当前服务器无法自动校验"
                    binding.tvAdminNames.visibility = View.GONE
                    showMessage(
                        "该账号需要重置密码\n\n$reason\n\n" +
                            body.adminContact?.message.orEmpty().ifBlank {
                                "您的密码没有输错。请联系管理员为您重置密码，重置后即可用新密码登录。"
                            },
                        showContact = true,
                    )

                    // 把管理员名字显出来，用户可以直接长按复制去联系人
                    val names = body.adminContact?.admins?.filter { it.isNotBlank() }.orEmpty()
                    if (names.isNotEmpty()) {
                        binding.tvAdminNames.text = names.joinToString(" · ")
                        binding.tvAdminNames.visibility = View.VISIBLE
                    }
                }
                else -> {
                    showMessage(body?.detail ?: "登录失败（HTTP ${r.code()}）")
                }
            }
        }
    }

    private fun parseError(r: Response<*>): AdminLoginResponse? {
        return try {
            val raw = r.errorBody()?.string() ?: return null
            com.google.gson.Gson().fromJson(raw, AdminLoginResponse::class.java)
        } catch (e: Exception) {
            null
        }
    }

    private fun doApply() {
        hideMessage()
        setBusy(true)
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                try {
                    val body = mapOf(
                        "note" to "通过管理端 App 申请",
                        "device_info" to "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
                    )
                    val r = AdminRetrofitClient.api().applyAdmin(body).execute()
                    r.isSuccessful
                } catch (e: Exception) {
                    false
                }
            }
            setBusy(false)
            if (ok) {
                showMessage("申请已提交。请让现有管理员在聊天端或管理端批准。")
            } else {
                showMessage("提交失败，请检查网络后重试")
            }
        }
    }
}
