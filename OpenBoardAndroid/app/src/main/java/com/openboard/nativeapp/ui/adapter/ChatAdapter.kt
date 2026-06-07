package com.openboard.nativeapp.ui.adapter

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.recyclerview.widget.RecyclerView
import coil.load
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.model.Message
import com.openboard.nativeapp.databinding.ItemMessageOtherBinding
import com.openboard.nativeapp.databinding.ItemMessageSelfBinding

/**
 * 聊天消息气泡渲染适配器，支持文字、图片展示、文件下载与已撤回系统文本渲染
 */
class ChatAdapter(
    private val messages: List<Message>,
    private val currentUser: String
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    var onMessageLongClick: ((Message) -> Unit)? = null
    
    private val imgRegex = Regex("\\[img:(.*?)\\]")
    private val fileRegex = Regex("\\[file:(.*?)\\|(.*?)\\]")

    override fun getItemCount() = messages.size

    override fun getItemViewType(position: Int): Int {
        val msg = messages[position]
        return if (msg.name == currentUser) 0 else 1
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        return if (viewType == 0) {
            val b = ItemMessageSelfBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            SelfViewHolder(b)
        } else {
            val b = ItemMessageOtherBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            OtherViewHolder(b)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val msg = messages[position]
        when (holder) {
            is SelfViewHolder -> holder.bind(msg)
            is OtherViewHolder -> holder.bind(msg)
        }
    }

    private fun bindMessageContent(
        content: String,
        isRecalled: Boolean,
        tvContent: TextView,
        ivImageNormal: ImageView,
        defaultTextColor: Int
    ) {
        val context = tvContent.context
        tvContent.setOnClickListener(null)

        if (isRecalled || content == "[system_recalled]" || content == "[Message recalled]") {
            tvContent.visibility = View.VISIBLE
            tvContent.text = "对方撤回了一条消息"
            tvContent.setTextColor(0xFF888888.toInt())
            ivImageNormal.visibility = View.GONE
            return
        }

        val imgMatch = imgRegex.find(content)
        val fileMatch = fileRegex.find(content)

        when {
            imgMatch != null -> {
                val url = imgMatch.groupValues[1]
                tvContent.visibility = View.GONE
                ivImageNormal.visibility = View.VISIBLE
                
                if (url.startsWith("data:image")) {
                    try {
                        val base64Data = url.substringAfter("base64,")
                        val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        ivImageNormal.setImageBitmap(bmp)
                    } catch (e: Exception) {
                        ivImageNormal.setImageResource(R.drawable.ic_attach)
                    }
                } else {
                    val fullUrl = if (url.startsWith("http")) url else RetrofitClient.getBaseUrl() + url.removePrefix("/")
                    ivImageNormal.load(fullUrl) {
                        placeholder(R.drawable.ic_attach)
                        error(R.drawable.ic_attach)
                    }
                }
            }
            fileMatch != null -> {
                val relativeUrl = fileMatch.groupValues[1]
                val filename = fileMatch.groupValues[2]
                val fullUrl = if (relativeUrl.startsWith("http")) relativeUrl else RetrofitClient.getBaseUrl() + relativeUrl.removePrefix("/")

                ivImageNormal.visibility = View.GONE
                tvContent.visibility = View.VISIBLE
                tvContent.text = "📎 文件: $filename\n(点击下载)"
                tvContent.setTextColor(0xFF00E5FF.toInt())
                
                if (tvContent.id == R.id.tv_content && tvContent.parent.parent is ViewGroup) {
                    tvContent.setTextColor(0xFF1976D2.toInt())
                }

                tvContent.setOnClickListener {
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(fullUrl))
                        context.startActivity(intent)
                    } catch (e: Exception) {
                        Toast.makeText(context, "无法打开下载链接", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            else -> {
                ivImageNormal.visibility = View.GONE
                tvContent.visibility = View.VISIBLE
                tvContent.text = content
                tvContent.setTextColor(defaultTextColor)
            }
        }
    }

    private fun bindAvatar(avatarStr: String?, ivAvatar: ImageView) {
        if (!avatarStr.isNullOrEmpty()) {
            try {
                val base64Data = if (avatarStr.startsWith("data:image")) {
                    avatarStr.substringAfter("base64,")
                } else {
                    avatarStr
                }
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                ivAvatar.setImageBitmap(bmp)
            } catch (e: Exception) {
                ivAvatar.setImageResource(R.drawable.ic_person)
            }
        } else {
            ivAvatar.setImageResource(R.drawable.ic_person)
        }
    }

    inner class SelfViewHolder(private val b: ItemMessageSelfBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(msg: Message) {
            bindMessageContent(msg.content, msg.isRecalled == 1, b.tvContent, b.ivImage, 0xFFFFFFFF.toInt())
            b.tvTime.text = msg.time ?: ""
            bindAvatar(msg.avatar, b.ivAvatar)

            b.root.setOnLongClickListener {
                onMessageLongClick?.invoke(msg)
                true
            }
        }
    }

    inner class OtherViewHolder(private val b: ItemMessageOtherBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(msg: Message) {
            b.tvName.text = msg.nickname ?: msg.name
            bindMessageContent(msg.content, msg.isRecalled == 1, b.tvContent, b.ivImage, 0xFF212121.toInt())
            b.tvTime.text = msg.time ?: ""
            bindAvatar(msg.avatar, b.ivAvatar)

            b.root.setOnLongClickListener {
                onMessageLongClick?.invoke(msg)
                true
            }
        }
    }
}
