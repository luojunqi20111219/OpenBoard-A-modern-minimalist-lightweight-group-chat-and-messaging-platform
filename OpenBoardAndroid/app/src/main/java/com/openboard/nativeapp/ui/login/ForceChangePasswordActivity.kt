package com.openboard.nativeapp.ui.login

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.repository.ApiErrorException
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.ActivityForceChangePasswordBinding
import kotlinx.coroutines.launch

/**
 * 强制改密页 —— 用默认密码登录后必须走完的最后一关。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 「自助重置为默认密码」让卡在旧格式哈希上的用户能进来一次，代价是
 * 密码变成了公开的 12345678。如果不强制改掉，这次重置等于把账号
 * 变成了公共账号 —— 任何人知道用户名就能登进来。
 *
 * 所以：服务端在重置后打 must_change_password 标记，登录响应带出，
 * MainActivity 检测到就立刻跳本页，**不改完不让进主界面**。
 *
 * ---------------------------------------------------------------------------
 * 几个刻意的设计
 * ---------------------------------------------------------------------------
 *   · 不显示返回/关闭入口，并吞掉系统返回键 —— 否则"强制"就是摆设
 *   · 旧密码恒为默认密码（用户就是刚用它登进来的），所以不用让用户填
 *   · 校验在客户端做一遍（即时反馈），服务端再做一遍（真正生效）
 *   · 改完密码后服务端会清掉全部会话，所以这里直接回登录页让用户重登
 */
class ForceChangePasswordActivity : AppCompatActivity() {

    private lateinit var binding: ActivityForceChangePasswordBinding
    private val repository = ChatRepository()

    companion object {
        /** 与服务端 DEFAULT_PASSWORD 一致；改密时作为 old_password 提交 */
        private const val DEFAULT_PASSWORD = "12345678"
        private const val MIN_PASSWORD_LENGTH = 8
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityForceChangePasswordBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 没登录就不该出现在这里
        if (!SessionManager.isLoggedIn) {
            redirectToLogin()
            return
        }

        binding.tvForceHint.text =
            "默认密码 $DEFAULT_PASSWORD 是公开的，任何人都能猜到。" +
                "请设置一个只有您自己知道的新密码，设置完成后才能进入聊天界面。"

        binding.btnSubmitPassword.setOnClickListener { submit() }
    }

    private fun submit() {
        val newPwd = binding.etNewPassword.text?.toString().orEmpty()
        val confirmPwd = binding.etConfirmPassword.text?.toString().orEmpty()

        // 客户端先拦一遍，给出即时的、能定位到具体输入框的提示
        if (newPwd.isEmpty()) {
            binding.tilNewPassword.error = "请输入新密码"
            return
        }
        binding.tilNewPassword.error = null

        if (newPwd.length < MIN_PASSWORD_LENGTH) {
            binding.tilNewPassword.error = "新密码至少 $MIN_PASSWORD_LENGTH 位"
            return
        }
        if (newPwd == DEFAULT_PASSWORD) {
            // 这条是闭环的关键：允许"改成"同一个默认密码的话，
            // 强制改密就完全失去意义了。服务端也会拒，这里先给更快的反馈。
            binding.tilNewPassword.error = "不能继续使用默认密码，请换一个"
            return
        }
        if (newPwd != confirmPwd) {
            binding.tilConfirmPassword.error = "两次输入的密码不一致"
            return
        }
        binding.tilConfirmPassword.error = null

        binding.progressBar.visibility = View.VISIBLE
        binding.btnSubmitPassword.isEnabled = false

        lifecycleScope.launch {
            // 旧密码 = 用户刚刚登录时用的默认密码
            val result = repository.updatePassword(DEFAULT_PASSWORD, newPwd)
            binding.progressBar.visibility = View.GONE
            binding.btnSubmitPassword.isEnabled = true

            result.onSuccess {
                // 服务端改密后会 revoke 全部会话，本地也必须清干净 ——
                // 不然残留的 token 会让用户"看起来还登着"，一发请求就 401。
                SessionManager.mustChangePassword = false
                SessionManager.clear()
                Toast.makeText(
                    this@ForceChangePasswordActivity,
                    "密码已修改，请用新密码重新登录",
                    Toast.LENGTH_LONG,
                ).show()
                redirectToLogin()
            }.onFailure { e ->
                val msg = (e as? ApiErrorException)?.error?.detail
                    ?: e.message
                    ?: "修改失败"
                Toast.makeText(this@ForceChangePasswordActivity, msg, Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * 吞掉返回键。
     *
     * 允许返回的话，用户一按就回到……其实哪也去不了（主界面已经被 finish 掉了），
     * 但会出现一个空白 Activity 或者退回桌面 —— 都很难解释。
     * 明确提示「请先完成密码修改」比让他撞墙更友好。
     */
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        Toast.makeText(this, "请先完成密码修改", Toast.LENGTH_SHORT).show()
    }

    private fun redirectToLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }
}
