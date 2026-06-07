package com.openboard.nativeapp.ui.adapter

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.openboard.nativeapp.data.model.Notification
import com.openboard.nativeapp.databinding.ItemNotificationBinding

/**
 * 系统通知/公告列表适配器
 */
class NotificationAdapter(
    private val items: MutableList<Notification> = mutableListOf(),
    private var lastReadId: Int = 0
) : RecyclerView.Adapter<NotificationAdapter.ViewHolder>() {

    fun updateData(newItems: List<Notification>, newLastReadId: Int) {
        items.clear()
        items.addAll(newItems)
        lastReadId = newLastReadId
        notifyDataSetChanged()
    }

    fun markAllRead(newLastReadId: Int) {
        lastReadId = newLastReadId
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemNotificationBinding.inflate(
            LayoutInflater.from(parent.context), parent, false
        )
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class ViewHolder(private val binding: ItemNotificationBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(item: Notification) {
            binding.tvSender.text = item.sender
            binding.tvTime.text = item.createdAt
            binding.tvContent.text = item.content

            // 判断是否未读：如果公告ID大于用户已读的最后公告ID，显示红点
            if (item.id > lastReadId) {
                binding.unreadDot.visibility = View.VISIBLE
            } else {
                binding.unreadDot.visibility = View.GONE
            }
        }
    }
}
