package com.openboard.nativeapp.ui.adapter

import android.graphics.BitmapFactory
import android.util.Base64
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.model.Group
import com.openboard.nativeapp.databinding.ItemGroupBinding

/**
 * 群聊列表适配器，展示群聊名字、分类（公开/私密）与头像
 */
class GroupAdapter(
    private val onClick: (Group) -> Unit
) : ListAdapter<Group, GroupAdapter.VH>(GroupDiff()) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemGroupBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(b)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(getItem(position))
    }

    inner class VH(private val b: ItemGroupBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(group: Group) {
            b.tvGroupName.text = group.name
            b.tvMemberCount.text = if (group.isPublic == 1) "公开群组" else "私密群组"

            val avatarStr = group.avatar
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
                    b.ivAvatar.setImageResource(R.drawable.ic_group)
                }
            } else {
                b.ivAvatar.setImageResource(R.drawable.ic_group)
            }

            b.root.setOnClickListener { onClick(group) }
        }
    }

    class GroupDiff : DiffUtil.ItemCallback<Group>() {
        override fun areItemsTheSame(oldItem: Group, newItem: Group) = oldItem.id == newItem.id
        override fun areContentsTheSame(oldItem: Group, newItem: Group) = oldItem == newItem
    }
}
