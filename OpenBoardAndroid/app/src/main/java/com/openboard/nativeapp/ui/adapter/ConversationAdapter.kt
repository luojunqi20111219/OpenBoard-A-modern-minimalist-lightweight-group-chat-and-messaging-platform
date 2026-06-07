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
import com.openboard.nativeapp.data.model.Conversation
import com.openboard.nativeapp.databinding.ItemConversationBinding

/**
 * 会话列表适配器，展示最近聊天的群组/私聊会话
 */
class ConversationAdapter(
    private val onClick: (Conversation) -> Unit
) : ListAdapter<Conversation, ConversationAdapter.VH>(ConvDiff()) {

    private val onlineUsers = mutableSetOf<String>()

    fun updateOnlineUsers(usersList: List<String>) {
        onlineUsers.clear()
        onlineUsers.addAll(usersList)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemConversationBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(b)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(getItem(position))
    }

    inner class VH(private val b: ItemConversationBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(conv: Conversation) {
            b.tvName.text = conv.name
            b.tvLastMessage.text = conv.lastMessage
            b.tvTime.text = conv.time

            // 未读计数器
            if (conv.unreadCount > 0) {
                b.tvUnreadCount.visibility = View.VISIBLE
                b.tvUnreadCount.text = conv.unreadCount.toString()
            } else {
                b.tvUnreadCount.visibility = View.GONE
            }

            // 在线状态指示灯（只在私信时渲染）
            if (conv.targetUser != null && onlineUsers.contains(conv.targetUser)) {
                b.onlineDot.visibility = View.VISIBLE
            } else {
                b.onlineDot.visibility = View.GONE
            }

            // 头像 Base64 渲染
            val avatarStr = conv.avatar
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
                if (conv.targetUser == null) {
                    b.ivAvatar.setImageResource(R.drawable.ic_group)
                } else {
                    b.ivAvatar.setImageResource(R.drawable.ic_person)
                }
            }

            b.root.setOnClickListener { onClick(conv) }
        }
    }

    class ConvDiff : DiffUtil.ItemCallback<Conversation>() {
        override fun areItemsTheSame(oldItem: Conversation, newItem: Conversation) =
            oldItem.id == newItem.id && oldItem.targetUser == newItem.targetUser
        override fun areContentsTheSame(oldItem: Conversation, newItem: Conversation) =
            oldItem == newItem
    }
}
