package com.openboard.nativeapp.ui.login

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.User
import com.openboard.nativeapp.data.repository.ApiErrorException
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.ActivityLoginBinding
import com.openboard.nativeapp.ui.main.MainActivity
import kotlinx.coroutines.launch

/**
 * 登录/注册页面，负责用户身份校验与动态设置服务器 API URL
 */
class LoginActivity : AppCompatActivity() {
    private lateinit var binding: ActivityLoginBinding
    private val repository = ChatRepository()
    private var isLoginMode = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // 自动登录判定
        if (SessionManager.isLoggedIn) {
            navigateToMain()
            return
        }

        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 预载入保存的自定义服务器地址
        binding.etServerUrl.setText(SessionManager.serverUrl)

        setupListeners()
    }

    private fun setupListeners() {
        binding.btnTabLogin.setOnClickListener {
            switchMode(true)
        }
        binding.btnTabRegister.setOnClickListener {
            switchMode(false)
        }
        binding.btnAction.setOnClickListener {
            if (isLoginMode) doLogin() else doRegister()
        }
        binding.btnMore.setOnClickListener { view ->
            val popup = androidx.appcompat.widget.PopupMenu(this, view)
            popup.menu.add(0, 1, 0, "设置服务器地址")
            popup.setOnMenuItemClickListener { item ->
                if (item.itemId == 1) {
                    showServerSettingsDialog()
                    true
                } else false
            }
            popup.show()
        }
    }

    private fun showServerSettingsDialog() {
        val builder = android.app.AlertDialog.Builder(this)
        builder.setTitle("设置服务器地址")
        
        val input = android.widget.EditText(this)
        input.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
        input.text = android.text.SpannableStringBuilder(SessionManager.serverUrl)
        builder.setView(input)
        
        builder.setPositiveButton("保存") { dialog, which ->
            val url = input.text.toString().trim()
            if (url.isNotEmpty()) {
                SessionManager.serverUrl = url
                binding.etServerUrl.setText(url)
                Toast.makeText(this, "服务器地址已更新", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "地址不能为空", Toast.LENGTH_SHORT).show()
            }
        }
        builder.setNegativeButton("取消") { dialog, which -> dialog.cancel() }
        builder.show()
    }

    private fun switchMode(loginMode: Boolean) {
        isLoginMode = loginMode
        if (isLoginMode) {
            binding.btnTabLogin.setTextColor(resources.getColor(com.openboard.nativeapp.R.color.primary, null))
            binding.btnTabRegister.setTextColor(resources.getColor(com.openboard.nativeapp.R.color.text_secondary, null))
            binding.tilNickname.visibility = View.GONE
            binding.btnAction.text = "立即登录"
        } else {
            binding.btnTabLogin.setTextColor(resources.getColor(com.openboard.nativeapp.R.color.text_secondary, null))
            binding.btnTabRegister.setTextColor(resources.getColor(com.openboard.nativeapp.R.color.primary, null))
            binding.tilNickname.visibility = View.VISIBLE
            binding.btnAction.text = "立即注册"
        }
    }

    private fun doLogin() {
        val serverUrl = binding.etServerUrl.text.toString().trim()
        if (serverUrl.isEmpty()) {
            Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
            return
        }
        SessionManager.serverUrl = serverUrl

        val username = binding.etUsername.text.toString().trim()
        val password = binding.etPassword.text.toString()
        if (username.isEmpty() || password.isEmpty()) {
            Toast.makeText(this, "用户名或密码不能为空", Toast.LENGTH_SHORT).show()
            return
        }

        // 清掉上一次的提示，避免用户改了输入框后旧提示还挂在页面上误导人
        hideLoginError()

        binding.progressBar.visibility = View.VISIBLE
        binding.btnAction.isEnabled = false

        lifecycleScope.launch {
            val result = repository.login(username, password)
            binding.progressBar.visibility = View.GONE
            binding.btnAction.isEnabled = true
            result.onSuccess { resp ->
                if (resp.code == 200 && resp.token != null) {
                    SessionManager.token = resp.token
                    val user = User(
                        id = resp.id,
                        username = resp.username ?: username,
                        nickname = resp.nickname,
                        avatar = resp.avatar
                    )
                    SessionManager.saveUser(user)
                    navigateToMain()
                } else {
                    Toast.makeText(this@LoginActivity, resp.msg ?: "登录失败", Toast.LENGTH_SHORT).show()
                }
            }.onFailure { e ->
                handleLoginFailure(e)
            }
        }
    }

    /**
     * 按失败原因给出**不同**的提示。
     *
     * 之前这里只把 401 特判成「用户名或密码错误」，其余一律显示
     * 「网络错误: API error: 400」——而 400 恰恰是最需要解释清楚的一种：
     * 用户的密码根本没输错，只是这个账号的密码是旧版格式，服务器算不动。
     * 笼统报「网络错误」会让人反复重试密码，白白触发登录锁定。
     */
    private fun handleLoginFailure(e: Throwable) {
        if (e !is ApiErrorException) {
            Toast.makeText(this, "网络错误：${e.message}", Toast.LENGTH_SHORT).show()
            return
        }

        val err = e.error
        when {
            // 旧版哈希算不动 → 给出联系管理员重置密码的通道
            err?.code == "PASSWORD_RESET_REQUIRED" -> {
                val reason = err.reason ?: "该账号的密码为旧版格式，当前服务器无法自动校验"
                showLoginError(
                    title = err.adminContact?.title ?: "该账号需要重置密码",
                    message = buildString {
                        append(reason)
                        append("\n\n")
                        append(
                            err.adminContact?.message
                                ?: "您的密码没有输错。请联系管理员为您重置密码，重置后即可用新密码登录。"
                        )
                    },
                    admins = err.adminContact?.admins,
                    actionLabel = err.adminContact?.actionLabel,
                )
            }

            e.statusCode == 401 ->
                Toast.makeText(this, "用户名或密码错误", Toast.LENGTH_SHORT).show()

            e.statusCode == 403 ->
                Toast.makeText(this, err?.detail ?: "该账号已被封禁", Toast.LENGTH_LONG).show()

            e.statusCode == 429 ->
                Toast.makeText(this, err?.detail ?: "登录尝试过多，请稍后再试", Toast.LENGTH_LONG).show()

            else ->
                Toast.makeText(
                    this,
                    err?.detail ?: "登录失败（HTTP ${e.statusCode}）",
                    Toast.LENGTH_SHORT,
                ).show()
        }
    }

    /**
     * 在登录表单下方显示常驻提示。
     *
     * @param admins 管理员用户名列表；为空则不显示名字行
     */
    private fun showLoginError(
        title: String,
        message: String,
        admins: List<String>?,
        actionLabel: String?,
    ) {
        binding.boxLoginError.visibility = View.VISIBLE
        binding.tvErrorTitle.text = title
        binding.tvErrorMessage.text = message

        val names = admins?.filter { it.isNotBlank() }.orEmpty()
        if (names.isNotEmpty()) {
            // 用 · 分隔，纯文本便于长按选中复制
            binding.tvAdminNames.text = names.joinToString(" · ")
            binding.tvAdminNames.visibility = View.VISIBLE
        } else {
            binding.tvAdminNames.visibility = View.GONE
        }

        binding.btnContactAdmin.text = actionLabel ?: "查看联系方式"
        binding.btnContactAdmin.visibility = View.VISIBLE
        binding.btnContactAdmin.setOnClickListener { openContactAdmin() }
    }

    private fun hideLoginError() {
        binding.boxLoginError.visibility = View.GONE
    }

    /**
     * 用系统浏览器打开服务端的 /contact-admin 页面。
     *
     * 不内嵌 WebView：那个页面本来就是给浏览器看的，交给系统浏览器
     * 更省事，用户也能自己复制页面内容。
     */
    private fun openContactAdmin() {
        // serverUrl 是可空的（尚未配置过服务器时就是 null）
        val base = SessionManager.serverUrl?.trim()?.trimEnd('/').orEmpty()
        if (base.isEmpty()) {
            Toast.makeText(this, "请先填写服务器地址", Toast.LENGTH_SHORT).show()
            return
        }
        val url = "$base/contact-admin"
        try {
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
        } catch (ex: Exception) {
            // 没有浏览器 / 地址不合法时，至少把地址显示出来让用户手抄
            Toast.makeText(this, "无法打开浏览器，请手动访问：$url", Toast.LENGTH_LONG).show()
        }
    }

    private fun doRegister() {
        val serverUrl = binding.etServerUrl.text.toString().trim()
        if (serverUrl.isEmpty()) {
            Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
            return
        }
        SessionManager.serverUrl = serverUrl

         val username = binding.etUsername.text.toString().trim()
         val password = binding.etPassword.text.toString()
         val nickname = binding.etNickname.text.toString().trim()
         if (username.isEmpty() || password.isEmpty()) {
             Toast.makeText(this, "请填写用户名和密码", Toast.LENGTH_SHORT).show()
             return
         }
 
         binding.progressBar.visibility = View.VISIBLE
         binding.btnAction.isEnabled = false
 
         lifecycleScope.launch {
             val result = repository.register(username, password, nickname.takeIf { it.isNotEmpty() })
             binding.progressBar.visibility = View.GONE
             binding.btnAction.isEnabled = true
            result.onSuccess { resp ->
                if (resp.code == 200 && resp.token != null) {
                    SessionManager.token = resp.token
                    val user = User(
                        id = resp.id,
                        username = resp.username ?: username,
                        nickname = resp.nickname,
                        avatar = resp.avatar
                    )
                    SessionManager.saveUser(user)
                    navigateToMain()
                } else {
                    Toast.makeText(this@LoginActivity, resp.msg ?: "注册失败", Toast.LENGTH_SHORT).show()
                }
            }.onFailure {
                Toast.makeText(this@LoginActivity, "网络错误: ${it.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun navigateToMain() {
        val intent = Intent(this, MainActivity::class.java).apply {
            this@LoginActivity.intent.extras?.let { putExtras(it) }
        }
        startActivity(intent)
        finish()
    }
}
