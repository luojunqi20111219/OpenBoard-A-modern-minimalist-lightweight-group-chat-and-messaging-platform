package com.openboard.admin.ui.review

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.admin.data.model.AuditMessage
import com.openboard.admin.databinding.ItemReviewMessageBinding
import com.openboard.admin.ui.common.humanTime

/**
 * 内容审核结果适配器。
 *
 * 一行一条消息，展示：发送者 / 会话 / 时间 / 正文。
 * 已被撤回的（内容被替换为 [system_recalled]）灰掉并标注 ——
 * 在 include_recalled 模式下它们会出现，但不能和正常消息长得一样，
 * 否则会误以为这些内容还在。
 */
class ReviewAdapter(
    private val onLongClick: (AuditMessage) -> Unit,
) : ListAdapter<AuditMessage, ReviewAdapter.VH>(DIFF) {

    class VH(val binding: ItemReviewMessageBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(ItemReviewMessageBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val m = getItem(position)
        val b = holder.binding
        val d = b.root.resources.displayMetrics.density

        // 头部：发送者 → 会话 · 时间
        b.tvHead.text = buildString {
            append(m.name)
            append("  →  ")
            append(m.conversationLabel)
            append("  ·  ")
            append(humanTime(m.createdAt))
        }
        b.tvHead.setTextColor(Color.parseColor("#6B7280"))

        b.tvContent.text = m.content ?: ""
        if (m.recalled) {
            b.tvContent.setTextColor(Color.parseColor("#9CA3AF"))
            b.tvContent.background = GradientDrawable().apply {
                cornerRadius = 6f * d
                setColor(Color.parseColor("#F3F4F6"))
            }
        } else {
            b.tvContent.setTextColor(Color.parseColor("#111827"))
            b.tvContent.background = null
        }

        // 标签行：已撤回 / 改过 N 次
        b.tvTags.visibility = if (m.recalled || m.editCount > 0) View.VISIBLE else View.GONE
        b.tvTags.text = buildList {
            if (m.recalled) add("已撤回")
            if (m.editCount > 0) add("改过 ${m.editCount} 次")
        }.joinToString("  ·  ")

        b.root.setOnLongClickListener {
            onLongClick(m)
            true
        }
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<AuditMessage>() {
            override fun areItemsTheSame(a: AuditMessage, b: AuditMessage) = a.id == b.id
            override fun areContentsTheSame(a: AuditMessage, b: AuditMessage) = a == b
        }
    }
}
