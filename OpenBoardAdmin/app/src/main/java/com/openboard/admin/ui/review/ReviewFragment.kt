package com.openboard.admin.ui.review

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openboard.admin.data.api.AdminRetrofitClient
import com.openboard.admin.data.model.AuditMessage
import com.openboard.admin.data.model.DeleteMessagesRequest
import com.openboard.admin.databinding.FragmentReviewBinding
import com.openboard.admin.ui.common.StateView
import com.openboard.admin.ui.common.errorMessage
import com.openboard.admin.ui.common.humanTime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 「内容审核」标签页 —— 跨用户检索 + 撤回 + 版本链追溯。
 *
 * ---------------------------------------------------------------------------
 * 为什么普通聊天端的搜索不够用
 * ---------------------------------------------------------------------------
 * 聊天端的 /messages/search 只能搜自己参与的会话（这是对的，不该让人
 * 随便翻别人的聊天记录）。但管理员处理举报、排查违规内容时必须全局检索，
 * 否则只能靠举报人截图，什么也查不到。
 *
 * 这里额外支持搜「历史原文」—— 违规内容的典型操作路径是"先发出去、
 * 被人看到、再偷偷改掉"，只搜当前正文会漏掉这类情况。
 *
 * 长按一条消息可以：
 *   · 撤回 —— 服务端把内容替换为 [system_recalled]（行保留，可事后追溯），
 *             并写审计日志
 *   · 查看修改历史 —— 完整版本链，从最初原文到当前内容
 */
class ReviewFragment : Fragment() {

    private var _binding: FragmentReviewBinding? = null
    private val binding get() = _binding!!

    private lateinit var stateView: StateView
    private lateinit var adapter: ReviewAdapter

    private val loaded = mutableListOf<AuditMessage>()
    private var total = 0
    private var loading = false

    private companion object {
        const val PAGE_SIZE = 50
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentReviewBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        stateView = StateView(binding.stateHost)
        adapter = ReviewAdapter(onLongClick = { showActions(it) })
        binding.recycler.layoutManager = LinearLayoutManager(requireContext())
        binding.recycler.adapter = adapter

        binding.btnSearch.setOnClickListener { search(reset = true) }
        binding.swipe.setOnRefreshListener { search(reset = true, silent = true) }
        binding.btnMore.setOnClickListener { loadMore() }

        // 回车即搜
        binding.etKeyword.setOnEditorActionListener { _, _, _ ->
            search(reset = true); true
        }

        stateView.empty("输入关键字开始检索\n\n提示：只输发送者可查出某人的全部发言")
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private fun loadMore() {
        if (loading) return
        runQuery(offset = loaded.size, reset = false)
    }

    private fun search(reset: Boolean, silent: Boolean = false) {
        if (!silent && reset) stateView.loading()
        runQuery(offset = 0, reset = true)
    }

    private fun runQuery(offset: Int, reset: Boolean) {
        if (loading) return

        val b = _binding ?: return
        val keyword = b.etKeyword.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val sender = b.etSender.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val roomRaw = b.etRoomId.text?.toString()?.trim()
        val roomId = roomRaw?.toIntOrNull()
        val includeRecalled = if (b.cbRecalled.isChecked) 1 else null

        // 三个条件全空就等于把整库拉回来 —— 拦住，避免误操作
        if (keyword == null && sender == null && roomId == null) {
            if (reset) {
                stateView.empty("请至少填写一个检索条件\n\n（关键字 / 发送者 / 群 ID）")
                b.recycler.visibility = View.GONE
                b.btnMore.visibility = View.GONE
                b.tvReviewCount.visibility = View.GONE
            }
            return
        }

        loading = true
        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().searchMessages(
                        query = keyword,
                        username = sender,
                        roomId = roomId,
                        includeRecalled = includeRecalled,
                        limit = PAGE_SIZE,
                        offset = offset,
                    ).execute()
                } catch (e: Exception) {
                    null
                }
            }

            val bb = _binding ?: run { loading = false; return@launch }
            bb.swipe.isRefreshing = false
            loading = false

            if (resp == null) {
                if (reset) stateView.error("网络错误，请检查服务器地址与网络")
                return@launch
            }
            if (!resp.isSuccessful) {
                if (reset) stateView.error(errorMessage(resp))
                return@launch
            }

            val body = resp.body()
            val page = body?.messages ?: emptyList()
            total = body?.total ?: page.size
            val historyHits = body?.historyMatches ?: emptyList()

            if (reset) loaded.clear()
            val seen = loaded.map { it.id }.toMutableSet()
            for (m in page) if (seen.add(m.id)) loaded.add(m)

            adapter.submitList(loaded.toList())

            bb.tvReviewCount.visibility = View.VISIBLE
            bb.tvReviewCount.text = buildString {
                append("匹配 ${total} 条")
                if (historyHits.isNotEmpty()) {
                    append("　·　历史原文另有 ${historyHits.size} 条命中")
                }
            }

            if (loaded.isEmpty() && historyHits.isEmpty()) {
                stateView.empty("没有匹配的消息")
                bb.recycler.visibility = View.GONE
                bb.btnMore.visibility = View.GONE
            } else {
                stateView.content()
                bb.recycler.visibility = View.VISIBLE
                bb.btnMore.visibility = if (loaded.size < total) View.VISIBLE else View.GONE

                // 历史原文命中单独提示 —— 它们不在分页结果里，
                // 但恰恰是最值得看的（说明有人改过内容）
                if (historyHits.isNotEmpty()) {
                    val first = historyHits.first()
                    Toast.makeText(
                        requireContext(),
                        "有关键字出现在历史原文里（消息 #${first.msgId}，编辑者 ${first.editor ?: "?"}），长按消息可查看完整版本",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    /** 长按后的操作菜单 */
    private fun showActions(m: AuditMessage) {
        val options = mutableListOf<String>()
        if (!m.recalled) options.add("撤回这条消息")
        options.add("查看修改历史")

        AlertDialog.Builder(requireContext())
            .setTitle("${m.name} 的消息")
            .setItems(options.toTypedArray()) { _, which ->
                when (options[which]) {
                    "撤回这条消息" -> confirmRecall(m)
                    "查看修改历史" -> showHistory(m)
                }
            }
            .show()
    }

    private fun confirmRecall(m: AuditMessage) {
        AlertDialog.Builder(requireContext())
            .setTitle("撤回消息")
            .setMessage(
                "内容会被替换为「[system_recalled]」，所有端同步消失。\n\n" +
                    "数据库里仍保留该行（用于事后追溯），此操作会记入操作日志。",
            )
            .setPositiveButton("撤回") { _, _ ->
                lifecycleScope.launch {
                    val resp = withContext(Dispatchers.IO) {
                        try {
                            AdminRetrofitClient.api()
                                .deleteMessages(DeleteMessagesRequest(listOf(m.id)))
                                .execute()
                        } catch (e: Exception) {
                            null
                        }
                    }
                    if (resp?.isSuccessful == true) {
                        Toast.makeText(requireContext(), "已撤回", Toast.LENGTH_SHORT).show()
                        search(reset = true, silent = true)
                    } else {
                        Toast.makeText(
                            requireContext(),
                            if (resp == null) "网络错误" else errorMessage(resp),
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 版本链：从最初原文到当前内容 */
    private fun showHistory(m: AuditMessage) {
        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                try {
                    AdminRetrofitClient.api().messageHistory(m.id).execute()
                } catch (e: Exception) {
                    null
                }
            }

            if (resp == null || !resp.isSuccessful) {
                Toast.makeText(
                    requireContext(),
                    if (resp == null) "网络错误" else errorMessage(resp),
                    Toast.LENGTH_LONG,
                ).show()
                return@launch
            }

            val versions = resp.body()?.versions ?: emptyList()
            if (versions.isEmpty()) {
                Toast.makeText(requireContext(), "这条消息没有被修改过", Toast.LENGTH_SHORT).show()
                return@launch
            }

            val ctx = requireContext()
            val d = resources.displayMetrics.density
            val container = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding((20 * d).toInt(), (8 * d).toInt(), (20 * d).toInt(), (8 * d).toInt())
            }

            versions.forEachIndexed { i, v ->
                val tag = if (v.isCurrent) "当前内容" else "版本 ${i + 1}（改前）"
                container.addView(
                    TextView(ctx).apply {
                        text = buildString {
                            append(tag)
                            append("  ·  ")
                            append(v.editor ?: "?")
                            append("  ·  ")
                            append(humanTime(v.editedAt))
                        }
                        textSize = 11.5f
                        setTextColor(android.graphics.Color.parseColor("#6B7280"))
                        setPadding(0, (8 * d).toInt(), 0, (3 * d).toInt())
                    },
                )
                container.addView(
                    TextView(ctx).apply {
                        text = v.content ?: ""
                        textSize = 14f
                        setTextColor(
                            if (v.isCurrent) android.graphics.Color.parseColor("#111827")
                            else android.graphics.Color.parseColor("#DC2626"),
                        )
                        setPadding(0, 0, 0, (6 * d).toInt())
                    },
                )
                if (i < versions.size - 1) {
                    container.addView(View(ctx).apply {
                        layoutParams = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT, (1 * d).toInt().coerceAtLeast(1),
                        )
                        setBackgroundColor(android.graphics.Color.parseColor("#EFEFEF"))
                    })
                }
            }

            android.widget.ScrollView(ctx).apply {
                addView(container)
                AlertDialog.Builder(ctx)
                    .setTitle("修改历史（共 ${versions.size} 个版本）")
                    .setView(this)
                    .setPositiveButton("关闭", null)
                    .show()
            }
        }
    }
}
