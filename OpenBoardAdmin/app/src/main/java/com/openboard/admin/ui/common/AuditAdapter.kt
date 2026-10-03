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
            // 群内操作标出来源 —— 合并展示后，光看 action 名分不清
            // "某人在群里静音了谁" 和 "某人在全局封禁了谁"
            if (item.isGroupSource) append("[群 ${item.groupId ?: "?"}] ")
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
            // 提权类 —— 最敏感，红色
            "admin.apply" -> "提交申请" to blue
            "admin.approve" -> "提权" to red
            "admin.revoke" -> "撤权" to red
            "admin.reject" -> "拒绝申请" to gray

            // 惩罚类 —— 橙色
            "admin.reset_password" -> "重置密码" to orange
            "admin.ban" -> "封禁" to orange
            "admin.unban" -> "解封" to blue
            "admin.mute" -> "禁言" to orange
            "admin.unmute" -> "解除禁言" to blue
            "admin.mute_group_member" -> "群内禁言" to orange
            "admin.unmute_group_member" -> "解除群内禁言" to blue
            "admin.delete_user" -> "删除用户" to red

            // 内容与群管理
            "admin.delete_messages" -> "撤回消息" to orange
            "admin.delete_group" -> "删除群聊" to red
            "admin.delete_groups" -> "批量删除群聊" to red
            "admin.freeze_group" -> "冻结/解冻群聊" to orange
            "admin.update_user_avatar" -> "改用户头像" to gray
            "admin.update_group_avatar" -> "改群头像" to gray

            "admin.broadcast" -> "全站广播" to blue
            "admin.migrate" -> "数据库迁移" to gray

            // 群内操作（group_audit_logs 的来源）
            "group.create" -> "建群" to blue
            "group.kick" -> "踢人" to orange
            "group.mute" -> "群内禁言" to orange
            "group.unmute" -> "解除群内禁言" to blue
            "group.transfer" -> "转让群主" to red
            "group.dismiss" -> "解散群" to red
            "group.update" -> "改群资料" to gray

            else -> action to gray
        }
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<AuditLogItem>() {
            /**
             * ⚠️ 用 stableKey（uid）而不是 id。
             *
             * 结果集合并了 admin_audit_logs 与 group_audit_logs，
             * 两张表的 id 各自自增，合并后必然重复。按 id 判同会让
             * 列表项串位、内容变了却复用旧 ViewHolder（视觉上闪烁）。
             */
            override fun areItemsTheSame(a: AuditLogItem, b: AuditLogItem) =
                a.stableKey == b.stableKey

            override fun areContentsTheSame(a: AuditLogItem, b: AuditLogItem) = a == b
        }
    }
}
