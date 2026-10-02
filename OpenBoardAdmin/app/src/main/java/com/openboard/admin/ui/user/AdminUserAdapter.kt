package com.openboard.admin.ui.user

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.admin.data.model.AdminUser
import com.openboard.admin.databinding.ItemAdminUserBinding
import com.openboard.admin.ui.common.bindAvatar
import com.openboard.admin.ui.common.roleColor
import com.openboard.admin.ui.common.roleLabel

/**
 * 用户列表适配器。
 *
 * 用 ListAdapter + DiffUtil 而不是 notifyDataSetChanged：
 * 搜索会频繁刷新列表，全量重绘会让正在滚动的列表跳回顶部，
 * 头像也会重新加载一遍。DiffUtil 只动真正变了的那几行。
 */
class AdminUserAdapter(
    /** 当前登录的管理员用户名 —— 自己那行不给封禁/重置入口 */
    private val me: String?,
    private val onResetPassword: (AdminUser) -> Unit,
    private val onToggleBan: (AdminUser) -> Unit,
) : ListAdapter<AdminUser, AdminUserAdapter.VH>(DIFF) {

    class VH(val binding: ItemAdminUserBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(ItemAdminUserBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val u = getItem(position)
        val b = holder.binding
        val ctx = b.root.context
        val d = ctx.resources.displayMetrics.density

        bindAvatar(b.tvAvatar, u.avatar, u.username)

        b.tvDisplayName.text = u.displayName
        b.tvUsername.text = if (u.displayName == u.username) u.username else "@${u.username}"

        // ---- 角色标签 ----
        val color = roleColor(u.role, u.isAdmin)
        b.tvRole.text = roleLabel(u.role, u.isAdmin)
        b.tvRole.setTextColor(color)
        b.tvRole.background = tagBg(color, d)
        b.tvRole.setPadding((7 * d).toInt(), (2 * d).toInt(), (7 * d).toInt(), (2 * d).toInt())

        // ---- 封禁标签 ----
        val danger = Color.parseColor("#DC2626")
        b.tvBanned.visibility = if (u.isBannedBool) android.view.View.VISIBLE else android.view.View.GONE
        b.tvBanned.setTextColor(danger)
        b.tvBanned.background = tagBg(danger, d)
        b.tvBanned.setPadding((7 * d).toInt(), (2 * d).toInt(), (7 * d).toInt(), (2 * d).toInt())

        // ---- 旧格式哈希警告 ----
        if (u.needsPasswordReset) {
            b.tvWarn.visibility = android.view.View.VISIBLE
            b.tvWarn.text = "密码为旧格式（${u.passwordAlgorithm ?: "未知"}），当前环境无法校验，需重置后才能登录"
        } else {
            b.tvWarn.visibility = android.view.View.GONE
        }

        // ---- 快捷操作 ----
        // 自己和系统账号不给操作入口：服务端也会拦，但这里提前隐藏更不容易误解
        val protected = (me != null && u.username == me) || u.isSystem
        b.btnReset.visibility = if (protected) android.view.View.GONE else android.view.View.VISIBLE
        b.btnBan.visibility = if (protected) android.view.View.GONE else android.view.View.VISIBLE
        b.btnBan.text = if (u.isBannedBool) "解封" else "封禁"

        b.btnReset.setOnClickListener { onResetPassword(u) }
        b.btnBan.setOnClickListener { onToggleBan(u) }

        b.root.setOnClickListener {
            val i = Intent(ctx, UserDetailActivity::class.java)
            i.putExtra(UserDetailActivity.EXTRA_USERNAME, u.username)
            ctx.startActivity(i)
        }
    }

    /** 浅底圆角标签 */
    private fun tagBg(color: Int, density: Float): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 7f * density
            setColor(
                Color.argb(
                    (255 * 0.11f).toInt(),
                    Color.red(color),
                    Color.green(color),
                    Color.blue(color),
                ),
            )
        }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<AdminUser>() {
            override fun areItemsTheSame(a: AdminUser, b: AdminUser) = a.id == b.id
            override fun areContentsTheSame(a: AdminUser, b: AdminUser) = a == b
        }
    }
}
