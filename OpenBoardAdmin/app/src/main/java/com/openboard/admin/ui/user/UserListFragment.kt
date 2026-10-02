package com.openboard.admin.ui.user

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.admin.data.AdminSession
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.AdminUser
import com.openboard.admin.databinding.FragmentUserListBinding
import com.openboard.admin.ui.common.StateView
import com.openboard.admin.ui.common.errorMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 用户列表页 —— 管理端的主力页面。
 *
 * 三件事：搜人、封人、重置密码。
 *
 * 关于"只看需要重置密码的账号"这个开关：
 * 旧库里的密码是 werkzeug 的 scrypt:32768:8:1，验证一次要 ~75ms CPU，
 * 而 Cloudflare 免费版每请求只有 10ms —— 这些账号物理上登不进来，
 * 必须由管理员设新密码。20 个用户里可能有十几个是这种情况，
 * 所以需要一个开关把他们筛出来逐个处理，而不是让管理员自己去猜。
 */
class UserListFragment : Fragment() {

    private var _binding: FragmentUserListBinding? = null
    private val binding get() = _binding!!

    private lateinit var stateView: StateView
    private lateinit var adapter: AdminUserAdapter
    private lateinit var session: AdminSession

    /** 全量数据（服务端一次最多回 500 条，本项目规模够用） */
    private var all: List<AdminUser> = emptyList()
    private var total = 0

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentUserListBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        session = AdminSession(requireContext())
        stateView = StateView(binding.stateHost)

        adapter = AdminUserAdapter(
            me = session.username,
            onResetPassword = { confirmResetPassword(it) },
            onToggleBan = { confirmToggleBan(it) },
        )
        binding.recycler.layoutManager = LinearLayoutManager(requireContext())
        binding.recycler.adapter = adapter

        binding.btnSearch.setOnClickListener { load() }
        binding.etSearch.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) {
                load(); true
            } else false
        }
        binding.swipe.setOnRefreshListener { load(silent = true) }

        // 切换开关时不需要重新请求 —— 全量数据已在手里，本地过滤即可
        binding.swOnlyNeedReset.setOnCheckedChangeListener { _, _ -> applyFilter() }

        load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    // -----------------------------------------------------------------------
    // 数据
    // -----------------------------------------------------------------------

    private fun load(silent: Boolean = false) {
        if (!silent) stateView.loading()
        val q = binding.etSearch.text?.toString()?.trim().orEmpty()

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().listUsers(q.ifEmpty { null }, limit = 500).execute()
                } catch (e: Exception) {
                    null
                }
            }
            val b = _binding ?: return@launch
            b.swipe.isRefreshing = false

            if (resp == null) {
                stateView.error("网络错误，请检查服务器地址与网络")
                return@launch
            }
            if (!resp.isSuccessful) {
                stateView.error(errorMessage(resp))
                return@launch
            }

            val body = resp.body()
            all = body?.users ?: emptyList()
            total = body?.total ?: all.size
            applyFilter()
        }
    }

    /** 本地过滤 + 渲染 */
    private fun applyFilter() {
        if (_binding == null) return
        val list = if (binding.swOnlyNeedReset.isChecked) {
            all.filter { it.needsPasswordReset }
        } else {
            all
        }

        val needReset = all.count { it.needsPasswordReset }
        binding.tvSummary.text = buildString {
            append("共 $total 个账号")
            if (needReset > 0) append(" · $needReset 个需重置密码")
            if (binding.swOnlyNeedReset.isChecked) append(" · 已筛选 ${list.size} 个")
        }

        adapter.submitList(list)

        if (list.isEmpty()) {
            if (all.isEmpty()) stateView.empty("没有找到匹配的用户")
            else stateView.empty("没有需要重置密码的账号")
            binding.recycler.visibility = View.GONE
        } else {
            stateView.content()
            binding.recycler.visibility = View.VISIBLE
        }
    }

    // -----------------------------------------------------------------------
    // 操作：重置密码
    // -----------------------------------------------------------------------

    private fun confirmResetPassword(u: AdminUser) {
        val ctx = requireContext()
        val input = EditText(ctx).apply {
            hint = "新密码（至少 6 位，含字母/数字/符号两类）"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val wrap = FrameLayout(ctx).apply {
            setPadding(dp(20), dp(4), dp(20), 0)
            addView(input)
        }

        AlertDialog.Builder(ctx)
            .setTitle("重置 ${u.username} 的密码")
            .setMessage(
                "该用户将无法再用旧密码登录，重置后需用新密码重新登录。\n" +
                    "（不会影响其他账号）",
            )
            .setView(wrap)
            .setPositiveButton("重置") { _, _ ->
                val pwd = input.text?.toString().orEmpty()
                if (pwd.isEmpty()) {
                    Toast.makeText(ctx, "密码不能为空", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                doResetPassword(u.username, pwd)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doResetPassword(username: String, newPassword: String) {
        lifecycleScope.launch {
            val err = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api()
                        .resetPassword(
                            com.openboard.admin.data.model.ResetPasswordRequest(username, newPassword),
                        )
                        .execute()
                    if (r.isSuccessful) null else errorMessage(r)
                } catch (e: Exception) {
                    "网络错误：${e.message}"
                }
            }
            val ctx = context ?: return@launch
            if (err == null) {
                // 服务端返回的算法是 pbkdf2:sha256:<当前迭代>，比原来的 scrypt 轻得多
                AlertDialog.Builder(ctx)
                    .setTitle("已重置")
                    .setMessage(
                        "$username 的密码已更新。\n\n" +
                            "请把新密码告诉该用户 —— 现在 TA 可以正常登录了。",
                    )
                    .setPositiveButton("好的", null)
                    .show()
                load(silent = true)
            } else {
                Toast.makeText(ctx, err, Toast.LENGTH_LONG).show()
            }
        }
    }

    // -----------------------------------------------------------------------
    // 操作：封禁 / 解封
    // -----------------------------------------------------------------------

    private fun confirmToggleBan(u: AdminUser) {
        val ctx = requireContext()
        val banning = !u.isBannedBool

        AlertDialog.Builder(ctx)
            .setTitle(if (banning) "封禁 ${u.username}" else "解除 ${u.username} 的封禁")
            .setMessage(
                if (banning) {
                    "封禁后该用户：\n" +
                        "· 无法登录\n" +
                        "· 所有在线连接会被立即断开\n" +
                        "· 已发送的消息保留\n\n可以随时解封。"
                } else {
                    "解除后该用户可以重新登录和收发消息。"
                },
            )
            .setPositiveButton(if (banning) "封禁" else "解封") { _, _ ->
                doToggleBan(u.username, banning)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doToggleBan(username: String, banned: Boolean) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api()
                        .banUsers(
                            com.openboard.admin.data.model.BanUsersRequest(listOf(username), banned),
                        )
                        .execute()
                    if (!r.isSuccessful) {
                        errorMessage(r)
                    } else {
                        val body = r.body()
                        if (body != null && body.affected == 0) {
                            body.skipped.firstOrNull()?.reason ?: "操作未生效"
                        } else null
                    }
                } catch (e: Exception) {
                    "网络错误：${e.message}"
                }
            }
            val ctx = context ?: return@launch
            if (result == null) {
                Toast.makeText(
                    ctx,
                    if (banned) "已封禁 $username" else "已解封 $username",
                    Toast.LENGTH_SHORT,
                ).show()
                load(silent = true)
            } else {
                Toast.makeText(ctx, result, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
