package com.openboard.nativeapp.ui.login

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.model.User
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.ActivityLoginBinding
import com.openboard.nativeapp.ui.main.MainActivity
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {
    private lateinit var binding: ActivityLoginBinding
    private val repository = ChatRepository()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.etServerUrl.setText(SessionManager.serverUrl)

        if (SessionManager.isLoggedIn) {
            navigateToMain()
            return
        }

        binding.btnLogin.setOnClickListener { doLogin() }
        binding.btnRegister.setOnClickListener { doRegister() }

        binding.tvSwitchLogin.setOnClickListener {
            val isLogin = binding.layoutLogin.visibility == View.VISIBLE
            binding.layoutLogin.visibility = if (isLogin) View.GONE else View.VISIBLE
            binding.layoutRegister.visibility = if (isLogin) View.VISIBLE else View.GONE
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
            Toast.makeText(this, "请填写所有字段", Toast.LENGTH_SHORT).show()
            return
        }
        binding.progressBar.visibility = View.VISIBLE
        binding.btnLogin.isEnabled = false

        lifecycleScope.launch {
            val result = repository.login(username, password)
            binding.progressBar.visibility = View.GONE
            binding.btnLogin.isEnabled = true
            result.onSuccess { resp ->
                if (resp.code == 200 && resp.token != null) {
                    SessionManager.token = resp.token
                    val user = User(
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

        val username = binding.etRegUsername.text.toString().trim()
        val password = binding.etRegPassword.text.toString()
        val nickname = binding.etRegNickname.text.toString().trim()
        if (username.isEmpty() || password.isEmpty() || nickname.isEmpty()) {
            Toast.makeText(this, "请填写所有字段", Toast.LENGTH_SHORT).show()
            return
        }
        binding.progressBar.visibility = View.VISIBLE
        binding.btnRegister.isEnabled = false

        lifecycleScope.launch {
            val result = repository.register(username, password, nickname)
            binding.progressBar.visibility = View.GONE
            binding.btnRegister.isEnabled = true
            result.onSuccess { resp ->
                if (resp.code == 200 && resp.token != null) {
                    SessionManager.token = resp.token
                    val user = User(
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
