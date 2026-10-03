package com.openboard.admin.ui.main

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.viewpager2.adapter.FragmentStateAdapter
import com.google.android.material.tabs.TabLayoutMediator
import com.openboard.admin.data.AdminSession
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.databinding.ActivityAdminMainBinding
import com.openboard.admin.ui.auth.AdminRequestsFragment
import com.openboard.admin.ui.common.AuditFragment
import com.openboard.admin.ui.dashboard.DashboardFragment
import com.openboard.admin.ui.login.AdminLoginActivity
import com.openboard.admin.ui.overview.OverviewFragment
import com.openboard.admin.ui.review.ReviewFragment
import com.openboard.admin.ui.user.UserListFragment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 管理端主界面。
 *
 * 七个标签页：
 *   概览 | 用户 | 审核 | 看板 | 授权 | 操作记录 | 服务器
 *
 * 进入时先检查迁移状态 —— 若新加的列还不存在，相关功能会静默失效
 * （比如禁言写不进 users.muted_until）。与其让用户遇到一堆莫名其妙的
 * 报错，不如在首页直接给一个「一键初始化」。
 *
 * ⚠️ 页签顺序一旦调整，[jumpToAuth] 里硬编码的索引必须同步改 ——
 *    否则概览页点「去处理」会跳到错误的页。
 */
class AdminMainActivity : AppCompatActivity(), OverviewFragment.OnJumpToAuth {

    private lateinit var binding: ActivityAdminMainBinding
    private lateinit var session: AdminSession

    private val titles = listOf("概览", "用户", "审核", "看板", "授权", "操作记录", "服务器")

    /** 授权页在 titles 里的下标 —— 与 [titles] 必须一起改 */
    private companion object {
        const val TAB_AUTH = 4
    }

    /** 授权页 Fragment 的引用 —— 概览页点「去处理」后要让它刷新 */
    private var authFragment: AdminRequestsFragment? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAdminMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        session = AdminSession(this)
        AdminRetrofitClient.setToken(session.token)
        session.baseUrl?.let { AdminRetrofitClient.setBaseUrl(it) }

        binding.toolbar.title = "OpenBoard 管理端 · ${session.username ?: ""}"
        binding.toolbar.setOnClickListener { showAccountMenu() }

        binding.pager.adapter = object : FragmentStateAdapter(this) {
            override fun getItemCount() = titles.size
            override fun createFragment(position: Int): Fragment = when (position) {
                0 -> OverviewFragment()
                1 -> UserListFragment()
                2 -> ReviewFragment()
                3 -> DashboardFragment()
                TAB_AUTH -> AdminRequestsFragment().also { authFragment = it }
                5 -> AuditFragment()
                else -> ServerFragment()
            }
        }
        binding.pager.offscreenPageLimit = titles.size
        TabLayoutMediator(binding.tabs, binding.pager) { tab, pos ->
            tab.text = titles[pos]
        }.attach()

        checkMigration()
    }

    /** 概览页的「去处理 →」—— 切到授权标签并刷新 */
    override fun jumpToAuth() {
        binding.pager.setCurrentItem(TAB_AUTH, true)
        authFragment?.refresh()
    }

    /** 点标题栏 → 账号操作菜单 */
    private fun showAccountMenu() {
        val items = arrayOf("刷新迁移状态", "退出登录")
        AlertDialog.Builder(this)
            .setTitle(session.username ?: "账号")
            .setItems(items) { _, which ->
                when (which) {
                    0 -> checkMigration(force = true)
                    1 -> {
                        session.clear()
                        AdminRetrofitClient.clearToken()
                        startActivity(Intent(this, AdminLoginActivity::class.java))
                        finish()
                    }
                }
            }
            .show()
    }

    /**
     * 检查管理员相关表/列是否就绪。
     *
     * ready=false 时显示提示条；点一下即可执行迁移（幂等）。
     */
    private fun checkMigration(force: Boolean = false) {
        lifecycleScope.launch {
            val status = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api().migrationStatus().execute()
                    if (r.isSuccessful) r.body() else null
                } catch (e: Exception) {
                    null
                }
            }

            if (status == null) {
                // 拉不到状态：可能是网络问题，也可能是后端还是旧版本
                // （没有这个接口）。不骚扰用户，只在强制刷新时提示。
                if (force) Toast.makeText(this@AdminMainActivity, "无法获取服务器状态", Toast.LENGTH_SHORT).show()
                return@launch
            }

            if (status.ready) {
                binding.tvMigrationBanner.visibility = View.GONE
                if (force) Toast.makeText(this@AdminMainActivity, "功能已就绪", Toast.LENGTH_SHORT).show()
                return@launch
            }

            // 未就绪 → 展示提示条，并提供一键初始化
            // 用模型自带的 missing 推导 —— 服务端和客户端各写一份清单
            // 迟早会对不上（之前就漏过 users_must_change_password）
            val missing = status.missing
            binding.tvMigrationBanner.visibility = View.VISIBLE
            binding.tvMigrationBanner.text =
                "数据库缺少：${missing.joinToString("、")}\n点此一键初始化（不会删除任何数据）"
            binding.tvMigrationBanner.setOnClickListener { confirmMigrate() }
        }
    }

    private fun confirmMigrate() {
        AlertDialog.Builder(this)
            .setTitle("初始化管理员功能")
            .setMessage(
                "将为数据库补充管理员功能所需的表与字段。\n\n" +
                    "· 不会删除或修改任何现有数据\n" +
                    "· 已有的 role=1 账号会自动同步为管理员\n" +
                    "· 重复执行是安全的",
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
            if (result == null) {
                Toast.makeText(this@AdminMainActivity, "初始化失败，请检查网络", Toast.LENGTH_LONG).show()
                return@launch
            }
            if (result.errors.isNotEmpty()) {
                AlertDialog.Builder(this@AdminMainActivity)
                    .setTitle("部分失败")
                    .setMessage(result.errors.joinToString("\n"))
                    .setPositiveButton("知道了", null)
                    .show()
                return@launch
            }
            Toast.makeText(
                this@AdminMainActivity,
                "初始化完成：${result.applied.joinToString("；").ifEmpty { "无需变更" }}",
                Toast.LENGTH_LONG,
            ).show()
            checkMigration(force = true)
        }
    }
}
