package com.openboard.admin.ui.main

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.openboard.admin.data.AdminSession
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.databinding.FragmentServerBinding
import com.openboard.admin.ui.common.errorMessage
import com.openboard.admin.ui.login.AdminLoginActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 「服务器」标签页 —— 配置与诊断。
 *
 * 这里的每个区块都是"出问题时才需要"的：
 *   · 换服务器地址（切测试环境）
 *   · 看管理功能是否已初始化 / 一键初始化
 *   · 看当前谁能管
 *
 * 之所以把这些放进 App 而不是只留命令行：管理端要能在手机上独立运作 ——
 * 出问题时不一定有电脑，而这个 App 的用户是管理员。
 */
class ServerFragment : Fragment() {

    private var _binding: FragmentServerBinding? = null
    private val binding get() = _binding!!

    private lateinit var session: AdminSession

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentServerBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        session = AdminSession(requireContext())

        binding.etServer.setText(AdminRetrofitClient.getBaseUrl())
        binding.btnSaveServer.setOnClickListener { saveServer() }
        binding.btnMigrate.setOnClickListener { confirmMigrate() }
        binding.btnLogout.setOnClickListener { confirmLogout() }

        binding.tvAbout.text = buildString {
            append("OpenBoard 管理端\n")
            append("版本 ${appVersion()}\n")
            append("接口：${AdminRetrofitClient.getBaseUrl()}")
        }

        renderAccount()
        loadMigrationStatus()
        loadAdmins()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private fun appVersion(): String = try {
        requireContext().packageManager
            .getPackageInfo(requireContext().packageName, 0).versionName ?: "?"
    } catch (e: Exception) {
        "?"
    }

    // -----------------------------------------------------------------------
    // 账号
    // -----------------------------------------------------------------------

    private fun renderAccount() {
        val b = binding
        b.boxAccount.removeAllViews()
        b.boxAccount.addView(row("用户名", session.username ?: "—"))
        b.boxAccount.addView(row("昵称", session.nickname ?: "—"))
        b.boxAccount.addView(
            row("状态", "已授权管理员", Color.parseColor("#15803D")),
        )
    }

    // -----------------------------------------------------------------------
    // 服务器地址
    // -----------------------------------------------------------------------

    private fun saveServer() {
        val url = binding.etServer.text?.toString()?.trim().orEmpty()
        if (url.isEmpty()) {
            toast("服务器地址不能为空")
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            toast("地址需以 http:// 或 https:// 开头")
            return
        }

        AdminRetrofitClient.setBaseUrl(url)
        session.baseUrl = AdminRetrofitClient.getBaseUrl()

        // 换了服务器，原 token 在新服务器上无意义 —— 直接退登更不容易出错
        AlertDialog.Builder(requireContext())
            .setTitle("已切换服务器")
            .setMessage("切换服务器需要重新登录。现在退出登录吗？")
            .setPositiveButton("重新登录") { _, _ -> logout() }
            .setNegativeButton("稍后", null)
            .show()
    }

    // -----------------------------------------------------------------------
    // 迁移状态
    // -----------------------------------------------------------------------

    private fun loadMigrationStatus() {
        lifecycleScope.launch {
            val status = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api().migrationStatus().execute()
                    if (r.isSuccessful) r.body() else null
                } catch (e: Exception) {
                    null
                }
            }
            val b = _binding ?: return@launch
            b.boxMigration.removeAllViews()

            if (status == null) {
                b.boxMigration.addView(row("状态", "无法获取", Color.parseColor("#DC2626")))
                b.tvConnResult.visibility = View.VISIBLE
                b.tvConnResult.setTextColor(Color.parseColor("#DC2626"))
                b.tvConnResult.text = "连不上服务器。请检查地址与网络后重试。"
                return@launch
            }

            b.tvConnResult.visibility = View.VISIBLE
            if (status.ready) {
                b.tvConnResult.setTextColor(Color.parseColor("#15803D"))
                b.tvConnResult.text = "连接正常，管理功能已就绪。"
            } else {
                b.tvConnResult.setTextColor(Color.parseColor("#B45309"))
                b.tvConnResult.text = "连接正常，但数据库缺少管理员功能所需的表/字段，请点下方按钮初始化。"
            }

            b.boxMigration.addView(
                row("users.is_admin", if (status.usersIsAdmin) "已就绪" else "缺失",
                    if (status.usersIsAdmin) Color.parseColor("#15803D") else Color.parseColor("#DC2626")),
            )
            b.boxMigration.addView(
                row("admin_requests", if (status.adminRequests) "已就绪" else "缺失",
                    if (status.adminRequests) Color.parseColor("#15803D") else Color.parseColor("#DC2626")),
            )
            b.boxMigration.addView(
                row("admin_audit_logs", if (status.adminAuditLogs) "已就绪" else "缺失",
                    if (status.adminAuditLogs) Color.parseColor("#15803D") else Color.parseColor("#DC2626")),
            )
        }
    }

    private fun confirmMigrate() {
        AlertDialog.Builder(requireContext())
            .setTitle("初始化管理功能")
            .setMessage(
                "将在数据库中补充管理员功能所需的字段与表：\n\n" +
                    "· users.is_admin 列\n" +
                    "· admin_requests 表\n" +
                    "· admin_audit_logs 表\n\n" +
                    "不会删除或修改任何现有数据，重复执行是安全的。",
            )
            .setPositiveButton("执行") { _, _ -> doMigrate() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doMigrate() {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api().applyMigrations().execute()
                    if (r.isSuccessful) r.body() else null
                } catch (e: Exception) {
                    null
                }
            }
            val ctx = context ?: return@launch
            if (result == null) {
                toast("初始化失败，请检查网络")
                return@launch
            }
            if (result.errors.isNotEmpty()) {
                AlertDialog.Builder(ctx)
                    .setTitle("部分失败")
                    .setMessage(result.errors.joinToString("\n"))
                    .setPositiveButton("知道了", null)
                    .show()
                return@launch
            }
            val done = result.applied.ifEmpty { listOf("无需变更（已是最新）") }
            AlertDialog.Builder(ctx)
                .setTitle("初始化完成")
                .setMessage(done.joinToString("\n"))
                .setPositiveButton("好的") { _, _ -> loadMigrationStatus() }
                .show()
        }
    }

    // -----------------------------------------------------------------------
    // 管理员名单
    // -----------------------------------------------------------------------

    private fun loadAdmins() {
        lifecycleScope.launch {
            val list = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api().listAdmins().execute()
                    if (r.isSuccessful) r.body()?.admins ?: emptyList() else emptyList()
                } catch (e: Exception) {
                    emptyList()
                }
            }
            val b = _binding ?: return@launch

            b.tvAdminListTitle.text = "管理员名单（${list.size}）"
            b.boxAdmins.removeAllViews()

            if (list.isEmpty()) {
                b.boxAdmins.addView(muted("读取失败或名单为空"))
                return@launch
            }
            for (a in list) {
                b.boxAdmins.addView(
                    row(
                        a.username + if (a.builtin) "  （保底）" else "",
                        if (a.username == session.username) "你自己" else "",
                        Color.parseColor("#6B7280"),
                    ),
                )
            }
        }
    }

    // -----------------------------------------------------------------------
    // 退出
    // -----------------------------------------------------------------------

    private fun confirmLogout() {
        AlertDialog.Builder(requireContext())
            .setTitle("退出登录")
            .setMessage("退出后需要重新输入账号密码。")
            .setPositiveButton("退出") { _, _ -> logout() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun logout() {
        session.clear()
        AdminRetrofitClient.clearToken()
        startActivity(Intent(requireContext(), AdminLoginActivity::class.java))
        requireActivity().finish()
    }

    // -----------------------------------------------------------------------
    // 小工具
    // -----------------------------------------------------------------------

    private fun row(label: String, value: String, valueColor: Int? = null): LinearLayout {
        val ctx = requireContext()
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

    private fun muted(text: String) = TextView(requireContext()).apply {
        this.text = text
        textSize = 13f
        setTextColor(Color.parseColor("#9CA3AF"))
        setPadding(0, (8 * resources.displayMetrics.density).toInt(), 0, 0)
    }

    private fun toast(text: String) {
        Toast.makeText(requireContext(), text, Toast.LENGTH_SHORT).show()
    }
}
