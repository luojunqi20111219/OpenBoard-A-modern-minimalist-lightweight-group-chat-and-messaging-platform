package com.openboard.nativeapp.ui.adapter

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openboard.nativeapp.data.model.Group
import com.openboard.nativeapp.databinding.ItemGroupBinding

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
            b.root.setOnClickListener { onClick(group) }
        }
    }

    class GroupDiff : DiffUtil.ItemCallback<Group>() {
        override fun areItemsTheSame(oldItem: Group, newItem: Group) = oldItem.id == newItem.id
        override fun areContentsTheSame(oldItem: Group, newItem: Group) = oldItem == newItem
    }
}
