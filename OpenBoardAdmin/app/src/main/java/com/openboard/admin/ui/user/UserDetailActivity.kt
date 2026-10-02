package com.openboard.admin.ui.user

import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.openboard.admin.data.AdminSession
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.AdminUser
import com.openboard.admin.data.model.ResetPasswordRequest
import com.openboard.admin.data.model.UserDetailResponse
import com.openboard.admin.databinding.ActivityUserDetailBinding
import com.openboard.admin.ui.common.bindAvatar
import com.openboard.admin.ui.common.errorMessage
import com.openboard.admin.ui.common.humanTime
import com.openboard.admin.ui.common.roleColor
import com.openboard.admin.ui.common.roleLabel
import com.openboard.admin.ui.common.roleLabel as labelOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 用户详情页。
 *
 * 这里放的是「对单个用户能做的所有事」：重置密码、封禁、授予/撤销管理权限、删除。
 * 列表页只给最常用的两个（重置密码、封禁），其余收在这里，避免列表行太挤。
 *
 * 每个危险操作都二次确认，且删号额外要求输入用户名 —— 这个操作不可撤销。
 */
class UserDetailActivity : AppCompatActivity() {

    private lateinit var binding: ActivityUserDetailBinding
    private lateinit var session: AdminSession

    private var username: String = ""
    private var detail: UserDetailResponse? = null

    /** 该用户当前是否在管理员名单里（含硬编码） */
    private var isAdmin = false

    /** 是否属于不可撤销的硬编码保底名单 */
    private var isBuiltinAdmin = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityUserDetailBinding.inflate(layoutInflater)
        setContentView(binding.root)

        session = AdminSession(this)

        username = intent.getStringExtra(EXTRA_USERNAME).orEmpty()
        if (username.isEmpty()) {
            Toast.makeText(this, "缺少用户名", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        binding.toolbar.title = username
        binding.toolbar.setNavigationOnClickListener { finish() }

        binding.btnResetPassword.setOnClickListener { confirmResetPassword() }
        binding.btnToggleBan.setOnClickListener { confirmToggleBan() }
        binding.btnDeleteUser.setOnClickListener { confirmDelete() }
        binding.btnGrantAdmin.setOnClickListener { confirmGrantAdmin() }
        binding.btnRevokeAdmin.setOnClickListener { confirmRevokeAdmin() }

        load()
    }

    // -----------------------------------------------------------------------
    // 加载
    // -----------------------------------------------------------------------

    private fun load() {
        binding.progress.visibility = View.VISIBLE

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().userDetail(username).execute()
                } catch (e: Exception) {
                    null
                }
            }

            // 顺带查一下是否在管理员名单里
            val adminList = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api().listAdmins().execute()
                    if (r.isSuccessful) r.body()?.admins ?: emptyList() else emptyList()
                } catch (e: Exception) {
                    emptyList()
                }
            }

            binding.progress.visibility = View.GONE

            if (resp == null) {
                Toast.makeText(this@UserDetailActivity, "网络错误", Toast.LENGTH_LONG).show()
                return@launch
            }
            if (!resp.isSuccessful) {
                AlertDialog.Builder(this@UserDetailActivity)
                    .setTitle("加载失败")
                    .setMessage(errorMessage(resp))
                    .setPositiveButton("返回") { _, _ -> finish() }
                    .show()
                return@launch
            }

            val entry = adminList.firstOrNull { it.username == username }
            isAdmin = (resp.body()?.user?.isAdmin == true) || entry != null
            isBuiltinAdmin = entry?.builtin == true

            detail = resp.body()
            render(resp.body())
        }
    }

    private fun render(d: UserDetailResponse?) {
        val u: AdminUser = d?.user ?: return
        val b = binding

        bindAvatar(b.tvAvatar, u.avatar, u.username)
        b.tvDisplayName.text = u.displayName
        b.tvUsername.text = "@${u.username}"

        val roleColorVal = roleColor(u.role, isAdmin)
        b.tvRoleLine.text = buildString {
            append(labelOf(u.role, isAdmin))
            if (u.isBannedBool) append(" · 已封禁")
        }
        b.tvRoleLine.setTextColor(roleColorVal)

        // ---- 统计 ----
        b.boxStats.removeAllViews()
        val stats = d.stats
        b.boxStats.addView(stat("消息", stats?.messages ?: 0))
        b.boxStats.addView(stat("设备", stats?.devices ?: 0))
        b.boxStats.addView(stat("登录", stats?.logins ?: 0))
        b.boxStats.addView(stat("群聊", stats?.groups ?: 0))

        // ---- 旧哈希警告 ----
        if (u.needsPasswordReset) {
            b.boxWarn.visibility = View.VISIBLE
            b.tvWarnBody.text =
                "密码算法：${u.passwordAlgorithm ?: "未知"}\n" +
                    "该格式在当前服务器环境下无法验证，用户用原密码登录会失败。" +
                    "请点下方「重置密码」为其设置新密码。"
        } else {
            b.boxWarn.visibility = View.GONE
        }

        // ---- 详细信息 ----
        b.boxInfo.removeAllViews()
        b.boxInfo.addView(infoRow("用户 ID", u.id.toString()))
        b.boxInfo.addView(infoRow("密码算法", u.passwordAlgorithm?.ifEmpty { "（空）" } ?: "（空）"))
        b.boxInfo.addView(infoRow("注册时间", u.createdAt?.take(19)?.replace("T", " ") ?: "未知"))
        b.boxInfo.addView(infoRow("封禁状态", if (u.isBannedBool) "已封禁" else "正常",
            if (u.isBannedBool) Color.parseColor("#DC2626") else Color.parseColor("#15803D")))
        b.boxInfo.addView(infoRow("管理权限", if (isAdmin) "是" else "否",
            if (isAdmin) Color.parseColor("#2563EB") else null))

        // ---- 群聊 ----
        val groups = d.groups
        b.tvGroupTitle.text = "所在群聊（${groups.size}）"
        b.tvGroups.text = if (groups.isEmpty()) {
            "未加入任何群聊"
        } else {
            groups.joinToString("、") { it.name ?: "#${it.id}" }
        }

        // ---- 管理权限按钮 ----
        val me = session.username
        val isSelf = me == username
        val canTouch = !isSelf && !u.isSystem

        when {
            isSelf -> {
                b.tvAdminHint.text = "这是你自己的账号，不能在这里修改自己的管理权限。"
                b.btnGrantAdmin.visibility = View.GONE
                b.btnRevokeAdmin.visibility = View.GONE
            }
            u.isSystem -> {
                b.tvAdminHint.text = "系统账号，不可变更权限。"
                b.btnGrantAdmin.visibility = View.GONE
                b.btnRevokeAdmin.visibility = View.GONE
            }
            isAdmin && isBuiltinAdmin -> {
                b.tvAdminHint.text = "该账号在服务器保底管理员名单中，撤销需修改 wrangler.toml 的 ALLOWED_ADMINS。"
                b.btnGrantAdmin.visibility = View.GONE
                b.btnRevokeAdmin.visibility = View.GONE
            }
            isAdmin -> {
                b.tvAdminHint.text = "该账号当前是管理员，可使用管理端全部功能。"
                b.btnGrantAdmin.visibility = View.GONE
                b.btnRevokeAdmin.visibility = View.VISIBLE
            }
            else -> {
                b.tvAdminHint.text = "该账号不是管理员。授予后 TA 可以登录管理端并执行管理操作。"
                b.btnGrantAdmin.visibility = View.VISIBLE
                b.btnRevokeAdmin.visibility = View.GONE
            }
        }

        // ---- 底部操作 ----
        b.btnResetPassword.visibility = if (canTouch) View.VISIBLE else View.GONE
        b.btnToggleBan.visibility = if (canTouch) View.VISIBLE else View.GONE
        b.btnDeleteUser.visibility = if (canTouch) View.VISIBLE else View.GONE
        b.btnToggleBan.text = if (u.isBannedBool) "解除封禁" else "封禁该用户"
    }

    private fun stat(label: String, value: Int): LinearLayout {
        val ctx = this
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)

            addView(TextView(ctx).apply {
                text = value.toString()
                textSize = 20f
                setTextColor(Color.parseColor("#2563EB"))
                gravity = android.view.Gravity.CENTER
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            addView(TextView(ctx).apply {
                text = label
                textSize = 11.5f
                setTextColor(Color.parseColor("#8A9099"))
                gravity = android.view.Gravity.CENTER
            })
        }
    }

    private fun infoRow(label: String, value: String, valueColor: Int? = null): LinearLayout {
        val ctx = this
        val d = resources.displayMetrics.density
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, (8 * d).toInt(), 0, (8 * d).toInt())

            addView(TextView(ctx).apply {
                text = label
                textSize = 13.5f
                setTextColor(Color.parseColor("#8A9099"))
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(TextView(ctx).apply {
                text = value
                textSize = 13.5f
                gravity = android.view.Gravity.END
                setTextColor(valueColor ?: Color.parseColor("#111827"))
            })
        }
    }

    // -----------------------------------------------------------------------
    // 操作
    // -----------------------------------------------------------------------

    private fun confirmResetPassword() {
        val input = EditText(this).apply {
            hint = "新密码（至少 6 位，含两类字符）"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val wrap = FrameLayout(this).apply {
            setPadding(dp(20), dp(4), dp(20), 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle("重置 $username 的密码")
            .setMessage("重置后该用户所有在线连接会被断开，需用新密码重新登录。")
            .setView(wrap)
            .setPositiveButton("重置") { _, _ ->
                val pwd = input.text?.toString().orEmpty()
                if (pwd.isEmpty()) {
                    toast("密码不能为空"); return@setPositiveButton
                }
                run("重置密码") {
                    AdminRetrofitClient.api()
                        .resetPassword(ResetPasswordRequest(username, pwd))
                        .execute()
                } onOk {
                    AlertDialog.Builder(this)
                        .setTitle("已重置")
                        .setMessage("$username 的新密码已生效，请转告该用户。")
                        .setPositiveButton("好的") { _, _ -> load() }
                        .show()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmToggleBan() {
        val banned = detail?.user?.isBannedBool == true
        AlertDialog.Builder(this)
            .setTitle(if (banned) "解除封禁" else "封禁 $username")
            .setMessage(if (banned) "解除后该用户可重新登录。" else "封禁后该用户无法登录，在线连接会被断开。")
            .setPositiveButton(if (banned) "解封" else "封禁") { _, _ ->
                run(if (banned) "解封" else "封禁") {
                    AdminRetrofitClient.api()
                        .banUsers(
                            com.openboard.admin.data.model.BanUsersRequest(listOf(username), !banned),
                        )
                        .execute()
                } onOk { load() }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmGrantAdmin() {
        AlertDialog.Builder(this)
            .setTitle("授予管理权限")
            .setMessage(
                "将把 $username 设为管理员。\n\n" +
                    "授予后 TA 可以：\n" +
                    "· 登录管理端 App\n" +
                    "· 封禁/解封其他用户\n" +
                    "· 重置他人密码\n" +
                    "· 继续授予或撤销其他人\n\n" +
                    "请确认你了解并信任该用户。",
            )
            .setPositiveButton("授予") { _, _ ->
                run("授予权限") {
                    AdminRetrofitClient.api().approveAdmin(mapOf("username" to username)).execute()
                } onOk {
                    toast("已授予 $username 管理权限")
                    load()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmRevokeAdmin() {
        if (isBuiltinAdmin) {
            toast("该账号在服务器保底名单中，无法撤销")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("撤销管理权限")
            .setMessage("撤销后 $username 将无法再登录管理端，也不能执行任何管理操作。")
            .setPositiveButton("撤销") { _, _ ->
                run("撤销权限") {
                    AdminRetrofitClient.api().revokeAdmin(mapOf("username" to username)).execute()
                } onOk {
                    toast("已撤销 $username 的管理权限")
                    load()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmDelete() {
        val input = EditText(this).apply {
            hint = "输入 $username 以确认"
            inputType = InputType.TYPE_CLASS_TEXT
        }
        val wrap = FrameLayout(this).apply {
            setPadding(dp(20), dp(4), dp(20), 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle("删除该用户")
            .setMessage(
                "此操作不可撤销，将永久删除：\n" +
                    "· 账号本身\n" +
                    "· TA 发送的所有消息\n" +
                    "· 好友关系与群成员身份\n" +
                    "· 登录历史与设备记录\n\n" +
                    "如果只是想暂时阻止登录，请改用「封禁」。",
            )
            .setView(wrap)
            .setPositiveButton("永久删除") { _, _ ->
                if (input.text?.toString()?.trim() != username) {
                    toast("用户名不匹配，已取消"); return@setPositiveButton
                }
                run("删除用户") {
                    AdminRetrofitClient.api().deleteUser(mapOf("username" to username)).execute()
                } onOk {
                    toast("已删除 $username")
                    finish()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // -----------------------------------------------------------------------
    // 通用执行包装
    // -----------------------------------------------------------------------

    /**
     * 跑一个管理操作，成功时回到调用方，失败时弹 toast。
     *
     * 写法说明：这里用了 `infix fun onOk`，看起来像 DSL 但其实就是
     * 把「失败处理」统一掉 —— 六个操作里每个都要写一遍
     * `if (err != null) toast(err) else ...`，重复六次不如抽出来。
     */
    private fun run(actionName: String, block: suspend () -> retrofit2.Response<*>): Result {
        binding.progress.visibility = View.VISIBLE
        return Result(actionName, block)
    }

    private inner class Result(
        private val actionName: String,
        private val block: suspend () -> retrofit2.Response<*>,
    ) {
        infix fun onOk(next: () -> Unit) {
            lifecycleScope.launch {
                val err = withContext(Dispatchers.IO) {
                    try {
                        val r = block()
                        if (r.isSuccessful) null else errorMessage(r)
                    } catch (e: Exception) {
                        "网络错误：${e.message}"
                    }
                }
                binding.progress.visibility = View.GONE
                if (err == null) next() else toast("$actionName 失败：$err")
            }
        }
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_USERNAME = "username"
    }
}
