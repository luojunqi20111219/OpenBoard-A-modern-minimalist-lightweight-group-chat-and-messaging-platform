package com.openboard.nativeapp.ui.adapter

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

class UserAdapter(
    private val onClick: (User) -> Unit
) : ListAdapter<User, UserAdapter.VH>(UserDiff()) {

    val onlineUsers = mutableSetOf<String>()

    fun updateOnlineUsers(users: Collection<String>) {
        onlineUsers.clear()
        onlineUsers.addAll(users)
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
            b.tvUsername.text = "@${user.username}"

            val avatarStr = user.avatar
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
                b.ivAvatar.setImageResource(R.drawable.ic_person)
            }

            if (onlineUsers.contains(user.username)) {
                b.viewOnlineIndicator.visibility = View.VISIBLE
            } else {
                b.viewOnlineIndicator.visibility = View.GONE
            }

            b.root.setOnClickListener { onClick(user) }
        }
    }

    class UserDiff : DiffUtil.ItemCallback<User>() {
        override fun areItemsTheSame(oldItem: User, newItem: User) = oldItem.username == newItem.username
        override fun areContentsTheSame(oldItem: User, newItem: User) = oldItem == newItem
    }
}
