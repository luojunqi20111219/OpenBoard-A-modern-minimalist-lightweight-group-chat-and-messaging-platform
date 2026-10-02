package com.openboard.nativeapp.ui.login

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
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

    companion object {
        /**
         * 自助重置用的默认密码，与服务端 DEFAULT_PASSWORD 保持一致。
         *
         * 仅作为**兜底文案**：正常情况下按钮上的密码取自服务端 400 响应里的
         * default_password 字段，这样两边改密码时不会对不上。
         * 只有服务端没下发（老版本）时才用这个值。
         */
        private const val DEFAULT_PASSWORD = "12345678"
    }

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

        // 后台静默探测服务端能力 —— 决定"重置为默认密码"按钮能不能出现。
        // 不阻塞 UI：探测结果回来之前用户可能已经点了登录，
        // 那种情况下会由 400 响应里的 self_service 兜底判定。
        probeServerCapabilities()
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
                // 换了服务器 → 之前探测到的能力已经作废（serverUrl 的 setter 会清缓存），
                // 这里对新地址重新探一次，否则「重置为默认密码」按钮的显隐
                // 会一直停留在上一台服务器的结论上。
                probeServerCapabilities()
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
                    // 服务端说"这个账号还在用默认密码"→ 让主界面把用户拦下来改密
                    SessionManager.mustChangePassword = resp.mustChangePassword
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
            // 旧版哈希算不动 → 给出「自助重置为默认密码」的主通道
            err?.code == "PASSWORD_RESET_REQUIRED" -> {
                val contact = err.adminContact
                val reason = err.reason ?: "该账号的密码为旧版格式，当前服务器无法自动校验"
                showLoginError(
                    title = contact?.title ?: "该账号需要重置密码",
                    message = buildString {
                        append(reason)
                        append("\n\n")
                        append(
                            contact?.message
                                ?: ("您的密码没有输错。可以把密码重置为默认密码后登录，" +
                                    "登录后请立即修改。")
                        )
                    },
                    admins = contact?.admins,
                    actionLabel = contact?.actionLabel,
                    // 严格判定：只有服务端明确说支持（self_service === true），
                    // 或者探测接口确认过这台服务器支持。见 showLoginError 里的说明。
                    selfServiceFromServer = contact?.selfService == true,
                    defaultPassword = contact?.defaultPassword,
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
     * @param selfServiceFromServer 服务端在 400 响应里是否**明确**声明支持自助重置。
     *        注意语义：只有 true 才算支持，null（老服务端）与 false 都按不支持处理。
     */
    private fun showLoginError(
        title: String,
        message: String,
        admins: List<String>?,
        actionLabel: String?,
        selfServiceFromServer: Boolean,
        defaultPassword: String?,
    ) {
        hideLoginSuccess()
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

        // ---- 自助重置按钮 ----
        //
        // 显示条件（两者都必须是"明确的 yes"，任一为否则不显示）：
        //   1. 调用方明确传入 selfService=true（来自 400 响应里的 self_service）
        //   2. 或者 探测接口确认过这台服务器支持（SessionManager 缓存）
        //
        // ⚠️ 这里没有 "?: true" 这种宽松兜底。
        //    老服务端的 400 带 admin_contact 但不带 self_service；
        //    普通版服务端连 admin_contact 都没有。这两种情况下如果按
        //    "没说不支持就是支持"来推断，就会显示一个点了必然失败的按钮 ——
        //    用户点下去拿到 404 或一坨 HTML，完全不知道发生了什么。
        //    所以：说不清楚 = 不支持。
        val selfService = selfServiceFromServer || SessionManager.supportsSelfReset

        // 默认密码优先用服务端下发的值，避免客户端与服务端硬编码不一致时按钮文案对不上
        val pwd = defaultPassword?.takeIf { it.isNotBlank() } ?: DEFAULT_PASSWORD
        if (selfService) {
            binding.btnResetDefault.text = "重置为默认密码 $pwd"
            binding.btnResetDefault.visibility = View.VISIBLE
            binding.btnResetDefault.isEnabled = true
            binding.btnResetDefault.setOnClickListener { confirmResetToDefault(pwd) }
        } else {
            binding.btnResetDefault.visibility = View.GONE
        }

        // 「查看联系方式」降为次要选项：admins 里只有站内用户名，
        // 用户其实很难用上，但留着总比没有强（比如他认识管理员本人）。
        binding.btnContactAdmin.text = actionLabel ?: "查看联系方式"
        binding.btnContactAdmin.visibility = View.VISIBLE
        binding.btnContactAdmin.setOnClickListener { openContactAdmin() }
    }

    private fun hideLoginError() {
        binding.boxLoginError.visibility = View.GONE
    }

    /** 重置成功后的提示（绿色），替换掉原来的橙色警示卡片 */
    private fun showLoginSuccess(title: String, message: String) {
        hideLoginError()
        binding.boxLoginSuccess.visibility = View.VISIBLE
        binding.tvSuccessTitle.text = title
        binding.tvSuccessMessage.text = message
    }

    private fun hideLoginSuccess() {
        binding.boxLoginSuccess.visibility = View.GONE
    }

    /**
     * 二次确认后再重置。
     *
     * 为什么一定要确认：这个操作**不可逆** —— 旧密码会立刻作废，
     * 而且新版是密码哈希，服务端也"算不回"原密码。
     * 误触的代价是用户彻底登不上，所以必须让他明确知道自己在做什么。
     */
    private fun confirmResetToDefault(password: String) {
        val username = binding.etUsername.text.toString().trim()
        if (username.isEmpty()) {
            Toast.makeText(this, "请先填写用户名", Toast.LENGTH_SHORT).show()
            return
        }

        AlertDialog.Builder(this)
            .setTitle("确认重置密码？")
            .setMessage(
                "将把「$username」的密码设为 $password。\n\n" +
                    "• 原来的密码会立即失效，无法找回\n" +
                    "• 登录后系统会要求您马上设置新密码\n" +
                    "• 每个账号每天只能重置一次"
            )
            .setNegativeButton("取消", null)
            .setPositiveButton("确认重置") { _, _ -> doResetToDefault(username, password) }
            .show()
    }

    private fun doResetToDefault(username: String, password: String) {
        binding.btnResetDefault.isEnabled = false
        binding.btnResetDefault.text = "正在重置…"

        lifecycleScope.launch {
            val result = repository.resetToDefault(username)
            result.onSuccess {
                showLoginSuccess(
                    "密码已重置",
                    "请用默认密码 $password 登录。登录后系统会要求您立即设置新密码，" +
                        "否则无法进入聊天界面。"
                )
                // 直接把密码填进去，用户点一下「登录」就能走完 —— 少一步手抄
                binding.etPassword.setText(password)
                binding.etPassword.setSelection(password.length)
                binding.btnAction.requestFocus()
                Toast.makeText(
                    this@LoginActivity,
                    "已重置，请点「登录」",
                    Toast.LENGTH_LONG,
                ).show()
            }.onFailure { e ->
                // 四个失败原因（今天重置过 / 账号无需重置 / 管理员账号 / 不存在）
                // 全靠 detail 区分，所以这里优先展示服务端原文
                val msg = (e as? ApiErrorException)?.error?.detail
                    ?: e.message
                    ?: "重置失败"
                Toast.makeText(this@LoginActivity, msg, Toast.LENGTH_LONG).show()
                // 恢复按钮，允许用户重试（尤其是"今天已重置过"之外的瞬时错误）
                binding.btnResetDefault.isEnabled = true
                binding.btnResetDefault.text = "重置为默认密码 $password"
            }
        }
    }

    /**
     * 静默探测服务端是否支持「自助重置为默认密码」。
     *
     * 为什么要探测：这个能力**只存在于 Cloudflare Workers 版服务端**。
     * 普通版（FastAPI）或老版本 CF 版都没有这个接口，如果客户端不问一句
     * 就把按钮显示出来，用户在那些服务器上点下去只会拿到 404 或 HTML 错误页。
     *
     * 失败即不支持 —— [ChatRepository.getCapabilities] 内部已经保证不抛异常，
     * 拿不到就返回空能力对象，[SessionManager.supportsSelfReset] 默认也是 false。
     *
     * 探测是"尽力而为"：它只影响按钮显不显示，失败没有任何副作用，
     * 所以这里不提示用户、也不重试。
     */
    private fun probeServerCapabilities() {
        // 已经针对当前服务器地址探测过就不重复探（省一次请求）
        if (SessionManager.capabilitiesProbed) return

        lifecycleScope.launch {
            val caps = repository.getCapabilities()
            SessionManager.serverKind = caps.server ?: "unknown"
            SessionManager.supportsSelfReset = caps.supportsSelfReset
        }
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
