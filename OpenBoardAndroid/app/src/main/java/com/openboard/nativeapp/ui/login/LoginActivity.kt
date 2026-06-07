package com.openboard.nativeapp.ui.login

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.User
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
            }.onFailure {
                Toast.makeText(this@LoginActivity, "网络错误: ${it.message}", Toast.LENGTH_SHORT).show()
            }
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
        if (username.isEmpty() || password.isEmpty() || nickname.isEmpty()) {
            Toast.makeText(this, "请填写所有字段", Toast.LENGTH_SHORT).show()
            return
        }

        binding.progressBar.visibility = View.VISIBLE
        binding.btnAction.isEnabled = false

        lifecycleScope.launch {
            val result = repository.register(username, password, nickname)
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
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
