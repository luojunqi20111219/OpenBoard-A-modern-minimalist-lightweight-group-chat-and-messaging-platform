package com.openboard.admin.ui.overview

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.ContentRequest
import com.openboard.admin.data.model.OverviewResponse
import com.openboard.admin.databinding.FragmentOverviewBinding
import com.openboard.admin.ui.common.errorMessage
import com.openboard.admin.ui.common.humanTime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 概览页 —— 管理端打开后的第一屏。
 *
 * 不追求"数据大屏"，只回答四个管理员真正关心的问题：
 *   1. 有多少人、多少人被封、多少人密码登不上
 *   2. 刚才大家在聊什么
 *   3. 有哪些群
 *   4. 有谁在等我批准
 */
class OverviewFragment : Fragment() {

    private var _binding: FragmentOverviewBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentOverviewBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // 概览是"看一眼就走"的页面，不缓存，每次进来都刷新
        binding.swipe.setOnRefreshListener { load(silent = true) }

        binding.btnBroadcast.setOnClickListener { askBroadcast() }

        binding.btnGoAuth.setOnClickListener {
            // 切到「授权」标签页。父 Activity 的 ViewPager 由 Activity 提供，
            // 这里用 requireActivity() 的接口回调最直接。
            (activity as? OnJumpToAuth)?.jumpToAuth()
        }

        load()
    }

    override fun onResume() {
        super.onResume()
        // 从用户页封完人回来，数字要跟着变
        if (_binding != null) load(silent = true)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    interface OnJumpToAuth {
        fun jumpToAuth()
    }

    private fun load(silent: Boolean = false) {
        if (!silent && _binding == null) return

        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().overview().execute()
                } catch (e: Exception) {
                    null
                }
            }
            val b = _binding ?: return@launch

            if (resp == null || !resp.isSuccessful) {
                b.swipe.isRefreshing = false
                if (!silent) {
                    val msg = if (resp == null) "网络错误，请检查服务器地址" else errorMessage(resp)
                    Toast.makeText(requireContext(), msg, Toast.LENGTH_LONG).show()
                }
                return@launch
            }

            val data = resp.body() ?: OverviewResponse()
            render(data)
            b.swipe.isRefreshing = false
        }
    }

    private fun render(data: OverviewResponse) {
        val b = _binding ?: return

        val banned = data.users.count { it.isBannedBool }
        val needReset = data.users.count { it.needsPasswordReset }

        b.tvUserCount.text = data.users.size.toString()
        b.tvMsgCount.text = data.messages.size.toString()
        b.tvOnlineCount.text = data.online.size.toString()
        b.tvBannedCount.text = banned.toString()
        b.tvResetCount.text = needReset.toString()

        // ---- 最近消息 ----
        b.boxMessages.removeAllViews()
        if (data.messages.isEmpty()) {
            b.boxMessages.addView(muted("暂无消息"))
        } else {
            for (m in data.messages.take(12)) {
                b.boxMessages.addView(messageRow(m.name ?: "?", m.content ?: "", m.createdAt))
            }
        }

        // ---- 群聊 ----
        b.boxGroups.removeAllViews()
        if (data.groups.isEmpty()) {
            b.boxGroups.addView(muted("暂无群聊"))
        } else {
            for (g in data.groups.take(20)) {
                val line = TextView(requireContext()).apply {
                    text = buildString {
                        append(g.name ?: "#${g.id}")
                        if (g.isPublic == 1) append("  · 公开")
                        if (g.isFrozen == 1) append("  · 已冻结")
                    }
                    textSize = 13.5f
                    setPadding(0, dp(7), 0, dp(7))
                    if (g.isFrozen == 1) setTextColor(0xFFB45309.toInt())
                }
                b.boxGroups.addView(line)
            }
        }

        // ---- 在线 ----
        b.tvOnlineTitle.text = "当前在线（${data.online.size}）"
        b.tvOnlineList.text = if (data.online.isEmpty()) {
            "目前没有在线用户"
        } else {
            data.online.take(60).joinToString("、")
        }
    }

    private fun messageRow(name: String, content: String, time: String?): View {
        val ctx = requireContext()
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(7), 0, dp(7))

            addView(
                LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    addView(
                        TextView(ctx).apply {
                            text = name
                            textSize = 12.5f
                            setTextColor(0xFF2563EB.toInt())
                            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                        },
                    )
                    addView(
                        TextView(ctx).apply {
                            text = humanTime(time)
                            textSize = 11.5f
                            setTextColor(0xFF9CA3AF.toInt())
                        },
                    )
                },
            )
            addView(
                TextView(ctx).apply {
                    // 消息可能是 [img:...] / [file:...] 这类富文本占位，截断展示
                    text = content.replace('\n', ' ').take(80)
                    textSize = 13.5f
                    setTextColor(0xFF374151.toInt())
                    maxLines = 2
                    setPadding(0, dp(2), 0, 0)
                },
            )
        }
    }

    private fun muted(text: String) = TextView(requireContext()).apply {
        this.text = text
        textSize = 13f
        setTextColor(0xFF9CA3AF.toInt())
        setPadding(0, dp(10), 0, dp(10))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /** 全站广播 */
    private fun askBroadcast() {
        val ctx = requireContext()
        val input = EditText(ctx).apply {
            hint = "输入要发送给所有人的公告"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
        }
        val wrap = android.widget.FrameLayout(ctx).apply {
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(input)
        }

        androidx.appcompat.app.AlertDialog.Builder(ctx)
            .setTitle("发送全站公告")
            .setView(wrap)
            .setPositiveButton("发送") { _, _ ->
                val content = input.text?.toString()?.trim().orEmpty()
                if (content.isEmpty()) {
                    Toast.makeText(ctx, "内容不能为空", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                doBroadcast(content)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doBroadcast(content: String) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val r = AdminRetrofitClient.api().broadcast(ContentRequest(content)).execute()
                    if (r.isSuccessful) null else errorMessage(r)
                } catch (e: Exception) {
                    "网络错误：${e.message}"
                }
            }
            val ctx = context ?: return@launch
            if (result == null) {
                Toast.makeText(ctx, "公告已发送", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(ctx, result, Toast.LENGTH_LONG).show()
            }
        }
    }
}
