package com.openboard.nativeapp.ui.adapter

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

class ConversationAdapter(
    private val onClick: (Conversation) -> Unit
) : ListAdapter<Conversation, ConversationAdapter.VH>(ConvDiff()) {

    val onlineUsers = mutableSetOf<String>()

    fun updateOnlineUsers(users: Collection<String>) {
        onlineUsers.clear()
        onlineUsers.addAll(users)
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
            b.tvLastMsg.text = conv.lastMessage
            b.tvTime.text = conv.time

            val avatarStr = conv.avatar
            if (!avatarStr.isNullOrEmpty()) {
                try {
                    val base64Data = if (avatarStr.startsWith("data:image")) {
                        avatarStr.substringAfter("base64,")
                    } else {
                        avatarStr
                    }
                    val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                    val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    b.ivAvatar.setImageBitmap(bmp)
                } catch (e: Exception) {
                    b.ivAvatar.setImageResource(R.drawable.ic_person)
                }
            } else {
                b.ivAvatar.setImageResource(
                    if (conv.id > 0) R.drawable.ic_group else R.drawable.ic_person
                )
            }

            // Show online dot only for single direct chats (id == 0)
            if (conv.id == 0 && conv.targetUser != null && onlineUsers.contains(conv.targetUser)) {
                b.viewOnlineIndicator.visibility = View.VISIBLE
            } else {
                b.viewOnlineIndicator.visibility = View.GONE
            }

            // Render unread count badge
            if (conv.unreadCount > 0) {
                b.tvUnread.visibility = View.VISIBLE
                b.tvUnread.text = if (conv.unreadCount > 99) "99+" else conv.unreadCount.toString()
            } else {
                b.tvUnread.visibility = View.INVISIBLE
            }

            b.root.setOnClickListener { onClick(conv) }
        }
    }

    class ConvDiff : DiffUtil.ItemCallback<Conversation>() {
        override fun areItemsTheSame(oldItem: Conversation, newItem: Conversation): Boolean {
            return oldItem.id == newItem.id && oldItem.targetUser == newItem.targetUser
        }

        override fun areContentsTheSame(oldItem: Conversation, newItem: Conversation): Boolean {
            return oldItem == newItem
        }
    }
}
