package com.openboard.admin.ui.auth

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.admin.data.model.AdminRequestItem
import com.openboard.admin.databinding.ItemAdminRequestBinding
import com.openboard.admin.ui.common.bindAvatar
import com.openboard.admin.ui.common.humanTime

/**
 * 管理员申请列表适配器。
 *
 * 三种状态用不同颜色 + 不同动作按钮：
 *   pending  → 显示「批准 / 拒绝」，橙色
 *   approved → 只读，绿色，并显示处理人
 *   rejected → 只读，灰色
 *
 * 已经是同一个人重复申请的情况被服务端的 UNIQUE(username, status)
 * 挡掉了，所以列表里一个人最多一条 pending。
 */
class AdminRequestAdapter(
    private val onApprove: (AdminRequestItem) -> Unit,
    private val onReject: (AdminRequestItem) -> Unit,
) : ListAdapter<AdminRequestItem, AdminRequestAdapter.VH>(DIFF) {

    class VH(val binding: ItemAdminRequestBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(ItemAdminRequestBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = getItem(position)
        val b = holder.binding
        val ctx = b.root.context
        val d = ctx.resources.displayMetrics.density

        bindAvatar(b.tvAvatar, null, item.username)
        b.tvUsername.text = item.username
        b.tvTime.text = humanTime(item.createdAt)

        // ---- 状态标签 ----
        val (statusText, statusColor) = when (item.status) {
            "approved" -> "已批准" to Color.parseColor("#15803D")
            "rejected" -> "已拒绝" to Color.parseColor("#8A9099")
            else -> "待处理" to Color.parseColor("#B45309")
        }
        b.tvStatus.text = statusText
        b.tvStatus.setTextColor(statusColor)
        b.tvStatus.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 7f * d
            setColor(
                Color.argb(
                    (255 * 0.12f).toInt(),
                    Color.red(statusColor), Color.green(statusColor), Color.blue(statusColor),
                ),
            )
        }
        b.tvStatus.setPadding((8 * d).toInt(), (3 * d).toInt(), (8 * d).toInt(), (3 * d).toInt())

        // ---- 申请说明 ----
        if (item.note.isNullOrBlank()) {
            b.tvNote.visibility = View.GONE
        } else {
            b.tvNote.visibility = View.VISIBLE
            b.tvNote.text = item.note
        }

        // ---- 设备信息 ----
        if (item.deviceInfo.isNullOrBlank()) {
            b.tvDevice.visibility = View.GONE
        } else {
            b.tvDevice.visibility = View.VISIBLE
            b.tvDevice.text = "设备：${item.deviceInfo}"
        }

        // ---- 动作 ----
        val pending = item.status == "pending"
        b.boxActions.visibility = if (pending) View.VISIBLE else View.GONE
        if (!pending && !item.handledBy.isNullOrBlank()) {
            b.tvDevice.visibility = View.VISIBLE
            b.tvDevice.text = buildString {
                if (!item.deviceInfo.isNullOrBlank()) append("设备：${item.deviceInfo}  ·  ")
                append("由 ${item.handledBy} 处理")
            }
        }

        b.btnApprove.setOnClickListener { onApprove(item) }
        b.btnReject.setOnClickListener { onReject(item) }
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<AdminRequestItem>() {
            override fun areItemsTheSame(a: AdminRequestItem, b: AdminRequestItem) = a.id == b.id
            override fun areContentsTheSame(a: AdminRequestItem, b: AdminRequestItem) = a == b
        }
    }
}
