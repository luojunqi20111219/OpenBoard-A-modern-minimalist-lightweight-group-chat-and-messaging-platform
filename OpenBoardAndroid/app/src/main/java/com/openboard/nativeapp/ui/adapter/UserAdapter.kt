package com.openboard.nativeapp.ui.adapter

import android.graphics.BitmapFactory
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.model.User
import com.openboard.nativeapp.databinding.ItemUserBinding

/**
 * 联系人列表适配器，支持展示拉黑状态与在线绿点
 */
class UserAdapter(
    private val onClick: (User) -> Unit
) : ListAdapter<User, UserAdapter.VH>(UserDiff()) {

    private val onlineUsers = mutableSetOf<String>()
    private val blockedUsers = mutableSetOf<String>()

    fun updateOnlineUsers(usersList: List<String>) {
        onlineUsers.clear()
        onlineUsers.addAll(usersList)
        notifyDataSetChanged()
    }

    fun updateBlockedUsers(usersList: List<String>) {
        blockedUsers.clear()
        blockedUsers.addAll(usersList)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemUserBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(b)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(getItem(position))
    }

    inner class VH(private val b: ItemUserBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(user: User) {
            b.tvName.text = user.nickname ?: user.username

            // 在线标识
            if (onlineUsers.contains(user.username)) {
                b.onlineDot.visibility = View.VISIBLE
            } else {
                b.onlineDot.visibility = View.GONE
            }

            // 拉黑标识
            if (blockedUsers.contains(user.username)) {
                b.ivBlocked.visibility = View.VISIBLE
            } else {
                b.ivBlocked.visibility = View.GONE
            }

            // 头像 Base64 渲染
            val avatarStr = user.avatar
            if (!avatarStr.isNullOrEmpty()) {
                try {
                    val base64Data = if (avatarStr.startsWith("data:image")) {
                        avatarStr.substringAfter("base64,")
                    } else {
                        avatarStr
                    }
                    val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    b.ivAvatar.setImageBitmap(bmp)
                } catch (e: Exception) {
                    b.ivAvatar.setImageResource(R.drawable.ic_person)
                }
            } else {
                b.ivAvatar.setImageResource(R.drawable.ic_person)
            }

            b.root.setOnClickListener { onClick(user) }
        }
    }

    class UserDiff : DiffUtil.ItemCallback<User>() {
        override fun areItemsTheSame(oldItem: User, newItem: User) = oldItem.username == newItem.username
        override fun areContentsTheSame(oldItem: User, newItem: User) = oldItem == newItem
    }
}
