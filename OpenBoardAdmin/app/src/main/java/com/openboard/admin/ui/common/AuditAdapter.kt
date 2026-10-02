package com.openboard.admin.ui.common

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.admin.data.model.AuditLogItem
import com.openboard.admin.databinding.ItemAuditLogBinding

/**
 * 操作记录适配器。
 *
 * 把服务端的 action 字符串（`admin.approve` 之类）翻成中文短语，
 * 并按类别给不同颜色 —— 提权类红色（最敏感）、封禁类橙色、其余灰色。
 * 管理员扫一眼就能看出哪几条是"有人被提权了"。
 */
class AuditAdapter : ListAdapter<AuditLogItem, AuditAdapter.VH>(DIFF) {

    class VH(val binding: ItemAuditLogBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(ItemAuditLogBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = getItem(position)
        val b = holder.binding
        val d = b.root.resources.displayMetrics.density

        val (label, color) = describe(item.action)
        b.tvAction.text = label
        b.tvAction.setTextColor(color)
        b.tvAction.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 7f * d
            setColor(
                Color.argb(
                    (255 * 0.12f).toInt(),
                    Color.red(color), Color.green(color), Color.blue(color),
                ),
            )
        }
        b.tvAction.setPadding((8 * d).toInt(), (3 * d).toInt(), (8 * d).toInt(), (3 * d).toInt())

        b.tvTime.text = humanTime(item.createdAt)

        b.tvBody.text = buildString {
            append(item.actor)
            if (!item.target.isNullOrBlank()) append(" → ${item.target}")
            if (!item.detail.isNullOrBlank()) append("\n${item.detail}")
        }
    }

    /** action → (中文标签, 颜色) */
    private fun describe(action: String): Pair<String, Int> {
        val red = Color.parseColor("#DC2626")
        val orange = Color.parseColor("#EA580C")
        val blue = Color.parseColor("#2563EB")
        val gray = Color.parseColor("#6B7280")

        return when (action) {
            "admin.apply" -> "提交申请" to blue
            "admin.approve" -> "提权" to red
            "admin.revoke" -> "撤权" to red
            "admin.reject" -> "拒绝申请" to gray
            "admin.reset_password" -> "重置密码" to orange
            "admin.ban" -> "封禁" to orange
            "admin.unban" -> "解封" to blue
            "admin.delete_user" -> "删除用户" to red
            "admin.broadcast" -> "全站广播" to blue
            "admin.migrate" -> "数据库迁移" to gray
            else -> action to gray
        }
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<AuditLogItem>() {
            override fun areItemsTheSame(a: AuditLogItem, b: AuditLogItem) = a.id == b.id
            override fun areContentsTheSame(a: AuditLogItem, b: AuditLogItem) = a == b
        }
    }
}
