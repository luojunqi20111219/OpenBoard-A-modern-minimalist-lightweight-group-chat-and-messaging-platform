package com.openboard.nativeapp.ui.adapter

import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.util.Base64
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.model.Conversation
import com.openboard.nativeapp.databinding.ItemConversationBinding

sealed class MergedItem {
    data class PinnedHeader(val isFolded: Boolean) : MergedItem()
    data class AllChatsHeader(val count: Int) : MergedItem()
    data class ChatItem(val conversation: Conversation, val isPinned: Boolean) : MergedItem()
}

class MergedConversationAdapter(
    private val onClick: (Conversation) -> Unit,
    private val onLongClick: (Conversation) -> Unit,
    private val onPinnedHeaderClick: () -> Unit
) : ListAdapter<MergedItem, RecyclerView.ViewHolder>(MergedDiffCallback()) {

    private val onlineUsers = mutableSetOf<String>()

    fun updateOnlineUsers(usersList: List<String>) {
        onlineUsers.clear()
        onlineUsers.addAll(usersList)
        notifyDataSetChanged()
    }

    override fun getItemViewType(position: Int): Int {
        return when (getItem(position)) {
            is MergedItem.PinnedHeader -> 0
            is MergedItem.AllChatsHeader -> 1
            is MergedItem.ChatItem -> 2
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val context = parent.context
        val density = context.resources.displayMetrics.density
        return when (viewType) {
            0 -> {
                // Pinned Header
                val layout = LinearLayout(context).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                    orientation = LinearLayout.HORIZONTAL
                    setPadding((16 * density).toInt(), (12 * density).toInt(), (16 * density).toInt(), (12 * density).toInt())
                    setBackgroundColor(0xFFE5E7EB.toInt()) // slightly darker grey for distinction
                    isClickable = true
                    focusable = View.FOCUSABLE
                    val attrs = intArrayOf(android.R.attr.selectableItemBackground)
                    val typedArray = context.obtainStyledAttributes(attrs)
                    setBackgroundResource(typedArray.getResourceId(0, 0))
                    typedArray.recycle()
                }
                val tvTitle = TextView(context).apply {
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    textSize = 13f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF4B5563.toInt())
                }
                val tvAction = TextView(context).apply {
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                    textSize = 12f
                    setTextColor(0xFF3B82F6.toInt())
                }
                layout.addView(tvTitle)
                layout.addView(tvAction)
                PinnedHeaderViewHolder(layout, tvTitle, tvAction)
            }
            1 -> {
                // All Chats Header
                val layout = LinearLayout(context).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                    orientation = LinearLayout.HORIZONTAL
                    setPadding((16 * density).toInt(), (12 * density).toInt(), (16 * density).toInt(), (12 * density).toInt())
                    setBackgroundColor(0xFFF3F4F6.toInt()) // light grey bg
                }
                val tvTitle = TextView(context).apply {
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                    textSize = 13f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF4B5563.toInt())
                }
                layout.addView(tvTitle)
                AllChatsHeaderViewHolder(layout, tvTitle)
            }
            else -> {
                val b = ItemConversationBinding.inflate(LayoutInflater.from(context), parent, false)
                ChatItemViewHolder(b)
            }
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val item = getItem(position)
        when (holder) {
            is PinnedHeaderViewHolder -> {
                val header = item as MergedItem.PinnedHeader
                holder.tvTitle.text = "📌 置顶聊天"
                holder.tvAction.text = if (header.isFolded) "展开 ∨" else "折叠 ∧"
                holder.itemView.setOnClickListener { onPinnedHeaderClick() }
            }
            is AllChatsHeaderViewHolder -> {
                val header = item as MergedItem.AllChatsHeader
                holder.tvTitle.text = "💬 联系人与群聊 (${header.count})"
            }
            is ChatItemViewHolder -> {
                val chat = item as MergedItem.ChatItem
                holder.bind(chat.conversation, chat.isPinned)
            }
        }
    }

    inner class PinnedHeaderViewHolder(
        val view: View,
        val tvTitle: TextView,
        val tvAction: TextView
    ) : RecyclerView.ViewHolder(view)

    inner class AllChatsHeaderViewHolder(
        val view: View,
        val tvTitle: TextView
    ) : RecyclerView.ViewHolder(view)

    inner class ChatItemViewHolder(private val b: ItemConversationBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(conv: Conversation, isPinned: Boolean) {
            b.tvName.text = conv.name
            b.tvLastMessage.text = if (conv.lastMessage.isEmpty()) "暂无消息" else conv.lastMessage
            b.tvTime.text = conv.time

            // Background distinguishing pinned vs normal
            if (isPinned) {
                b.root.setBackgroundColor(0xFFF3F4F6.toInt())
            } else {
                val attrs = intArrayOf(android.R.attr.selectableItemBackground)
                val typedArray = b.root.context.obtainStyledAttributes(attrs)
                b.root.setBackgroundResource(typedArray.getResourceId(0, 0))
                typedArray.recycle()
            }

            // Unread Badge
            if (conv.unreadCount > 0) {
                b.tvUnreadCount.visibility = View.VISIBLE
                b.tvUnreadCount.text = conv.unreadCount.toString()
            } else {
                b.tvUnreadCount.visibility = View.GONE
            }

            // Online Dot
            if (conv.targetUser != null && onlineUsers.contains(conv.targetUser)) {
                b.onlineDot.visibility = View.VISIBLE
            } else {
                b.onlineDot.visibility = View.GONE
            }

            // Avatar base64 loading
            b.ivAvatar.clearColorFilter()
            val avatarStr = conv.avatar
            if (avatarStr == "system_filehelper") {
                b.ivAvatar.setImageResource(R.drawable.ic_chats)
                b.ivAvatar.setColorFilter(b.ivAvatar.resources.getColor(R.color.primary, null))
            } else if (!avatarStr.isNullOrEmpty()) {
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
            b.root.setOnLongClickListener {
                onLongClick(conv)
                true
            }
        }
    }

    class MergedDiffCallback : DiffUtil.ItemCallback<MergedItem>() {
        override fun areItemsTheSame(oldItem: MergedItem, newItem: MergedItem): Boolean {
            if (oldItem is MergedItem.PinnedHeader && newItem is MergedItem.PinnedHeader) return true
            if (oldItem is MergedItem.AllChatsHeader && newItem is MergedItem.AllChatsHeader) return true
            if (oldItem is MergedItem.ChatItem && newItem is MergedItem.ChatItem) {
                val oldConv = oldItem.conversation
                val newConv = newItem.conversation
                return oldConv.id == newConv.id && oldConv.targetUser == newConv.targetUser
            }
            return false
        }

        override fun areContentsTheSame(oldItem: MergedItem, newItem: MergedItem): Boolean {
            return oldItem == newItem
        }
    }
}
