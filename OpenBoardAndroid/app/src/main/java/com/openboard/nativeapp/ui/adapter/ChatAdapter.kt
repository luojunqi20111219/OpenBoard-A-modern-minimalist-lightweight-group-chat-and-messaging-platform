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
import com.openboard.nativeapp.ui.theme.ThemeManager

/**
 * 聊天消息气泡渲染适配器，支持文字、图片展示、文件下载与已撤回系统文本渲染
 */
class ChatAdapter(
    private val messages: List<Message>,
    private val currentUser: String
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    var onMessageLongClick: ((Message) -> Unit)? = null
    var onAvatarClick: ((Message) -> Unit)? = null
    var onActionOptionClick: ((option: String, message: Message, selectedText: String) -> Unit)? = null
    var onReplyQuoteClick: ((parentId: Int) -> Unit)? = null

    private var highlightedPosition: Int = -1

    fun highlightItem(position: Int) {
        val prev = highlightedPosition
        highlightedPosition = position
        if (prev != -1) notifyItemChanged(prev)
        notifyItemChanged(position)
        
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            if (highlightedPosition == position) {
                highlightedPosition = -1
                notifyItemChanged(position)
            }
        }, 1500)
    }
    
    private val imgRegex = Regex("\\[img:(.*?)\\]")
    private val fileRegex = Regex("\\[file:(.*?)\\|(.*?)\\]")
    private val cardRegex = Regex("\\[user_card:([^:\\]]+)(?::([^:\\]]*))?(?::([^\\]]*))?\\]")

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
            is SelfViewHolder -> holder.bind(msg, position)
            is OtherViewHolder -> holder.bind(msg, position)
        }
    }

    private fun bindMessageContent(
        msg: Message,
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
        val cardMatch = cardRegex.find(content)

        when {
            cardMatch != null -> {
                val targetUsername = cardMatch.groupValues[1]
                val encodedNickname = cardMatch.groupValues.getOrElse(2) { "" }
                val encodedAvatar = cardMatch.groupValues.getOrElse(3) { "" }
                val targetNickname = try {
                    java.net.URLDecoder.decode(encodedNickname, "UTF-8")
                } catch (e: Exception) {
                    encodedNickname
                }.ifEmpty { targetUsername }
                val targetAvatar = try {
                    java.net.URLDecoder.decode(encodedAvatar, "UTF-8")
                } catch (e: Exception) {
                    encodedAvatar
                }

                tvContent.visibility = View.VISIBLE
                ivImageNormal.visibility = View.GONE
                
                val cardText = "📇 个人名片\n" +
                               "━━━━━━━━━━━━━━━\n" +
                               "昵称：$targetNickname\n" +
                               "账号：@$targetUsername\n" +
                               "━━━━━━━━━━━━━━━\n" +
                               "点击此处查看名片 / 添加好友"
                tvContent.text = cardText
                tvContent.setTextColor(0xFF3F51B5.toInt())
                tvContent.setOnClickListener {
                    val dummyMessage = Message(
                        id = 0,
                        roomId = 0,
                        name = targetUsername,
                        nickname = targetNickname,
                        content = "",
                        time = "",
                        avatar = targetAvatar.ifEmpty { null }
                    )
                    onAvatarClick?.invoke(dummyMessage)
                }
            }
            imgMatch != null -> {
                val imageParts = imgMatch.groupValues[1].split("|", limit = 2)
                val originalUrl = imageParts[0]
                val displayUrl = imageParts.getOrElse(1) { originalUrl }
                tvContent.visibility = View.GONE
                ivImageNormal.visibility = View.VISIBLE

                val fullUrl = if (originalUrl.startsWith("http")) originalUrl else RetrofitClient.getBaseUrl() + originalUrl.removePrefix("/")
                val fullDisplayUrl = if (displayUrl.startsWith("http")) displayUrl else RetrofitClient.getBaseUrl() + displayUrl.removePrefix("/")
                ivImageNormal.setOnClickListener {
                    try {
                        val dialog = android.app.Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
                        val root = android.widget.FrameLayout(context).apply {
                            layoutParams = android.view.ViewGroup.LayoutParams(
                                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                                android.view.ViewGroup.LayoutParams.MATCH_PARENT
                            )
                            setBackgroundColor(0xFF000000.toInt())
                        }
                        val imageView = android.widget.ImageView(context).apply {
                            layoutParams = android.widget.FrameLayout.LayoutParams(
                                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                                android.widget.FrameLayout.LayoutParams.MATCH_PARENT
                            )
                            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                        }
                        root.addView(imageView)

                        val btnSave = android.widget.TextView(context).apply {
                            text = "保存图片"
                            setTextColor(0xFFFFFFFF.toInt())
                            textSize = 15f
                            setPadding(40, 20, 40, 20)
                            setBackground(android.graphics.drawable.GradientDrawable().apply {
                                setColor(0x99000000.toInt())
                                cornerRadius = 30f
                            })
                            layoutParams = android.widget.FrameLayout.LayoutParams(
                                android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
                            ).apply {
                                gravity = android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL
                                bottomMargin = 120
                            }
                        }
                        root.addView(btnSave)

                        if (originalUrl.startsWith("data:image")) {
                            val base64Data = originalUrl.substringAfter("base64,")
                            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            imageView.setImageBitmap(bmp)
                        } else {
                            imageView.load(fullUrl) {
                                placeholder(R.drawable.ic_attach)
                                error(R.drawable.ic_attach)
                            }
                        }

                        val dismissAction = { dialog.dismiss() }
                        imageView.setOnClickListener { dismissAction() }
                        root.setOnClickListener { dismissAction() }

                        btnSave.setOnClickListener {
                            val drawable = imageView.drawable
                            if (drawable is android.graphics.drawable.BitmapDrawable) {
                                val bitmap = drawable.bitmap
                                checkAndSaveImage(context, bitmap)
                            } else if (drawable != null) {
                                try {
                                    val bitmap = android.graphics.Bitmap.createBitmap(
                                        drawable.intrinsicWidth.coerceAtLeast(1),
                                        drawable.intrinsicHeight.coerceAtLeast(1),
                                        android.graphics.Bitmap.Config.ARGB_8888
                                    )
                                    val canvas = android.graphics.Canvas(bitmap)
                                    drawable.setBounds(0, 0, canvas.width, canvas.height)
                                    drawable.draw(canvas)
                                    checkAndSaveImage(context, bitmap)
                                } catch (e: Exception) {
                                    Toast.makeText(context, "转换图片失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                }
                            } else {
                                Toast.makeText(context, "图片尚未加载完毕", Toast.LENGTH_SHORT).show()
                            }
                        }

                        dialog.setContentView(root)
                        dialog.show()
                    } catch (e: Exception) {
                        Toast.makeText(context, "无法放大图片", Toast.LENGTH_SHORT).show()
                    }
                }
                ivImageNormal.setOnLongClickListener {
                    onMessageLongClick?.invoke(msg)
                    true
                }

                if (displayUrl.startsWith("data:image")) {
                    try {
                        val base64Data = displayUrl.substringAfter("base64,")
                        val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        ivImageNormal.setImageBitmap(bmp)
                    } catch (e: Exception) {
                        ivImageNormal.setImageResource(R.drawable.ic_attach)
                    }
                } else {
                    ivImageNormal.load(fullDisplayUrl) {
                        placeholder(R.drawable.ic_attach)
                        error(R.drawable.ic_attach)
                        listener(
                            onStart = { request -> android.util.Log.d("ChatAdapter", "Coil start loading: ${request.data}") },
                            onSuccess = { request, _ -> android.util.Log.d("ChatAdapter", "Coil load success: ${request.data}") },
                            onError = { request, result -> android.util.Log.e("ChatAdapter", "Coil load error: ${request.data}, throwable: ${result.throwable.message}", result.throwable) }
                        )
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
        ivAvatar.clearColorFilter()
        if (avatarStr == "system_filehelper") {
            ivAvatar.setImageResource(R.drawable.ic_chats)
            ivAvatar.setColorFilter(ivAvatar.resources.getColor(R.color.primary, null))
            return
        }
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
        fun bind(msg: Message, position: Int) {
            b.tvContent.background = ThemeManager.buildBubbleSelf(b.root.context)
            bindMessageContent(msg, msg.content, msg.isRecalled == 1, b.tvContent, b.ivImage, 0xFF212121.toInt())
            b.tvNameSelf.visibility = if (msg.receiver == null) View.VISIBLE else View.GONE
            b.tvNameSelf.text = "${msg.nickname ?: msg.name} (@${msg.name})"
            b.tvTime.text = messageStatusText(msg, true)
            bindAvatar(msg.avatar, b.ivAvatar)

            b.ivAvatar.setOnClickListener {
                onAvatarClick?.invoke(msg)
            }

            setupTextSelection(b.tvContent, msg, true)

            // Quote positioning click listener
            if (!msg.reply.isNullOrEmpty() && msg.isRecalled != 1) {
                val parentId = msg.reply.toIntOrNull()
                if (parentId != null) {
                    b.tvContent.setOnClickListener {
                        onReplyQuoteClick?.invoke(parentId)
                    }
                }
            }

            // Highlight overlay
            val isHighlighted = position == highlightedPosition
            if (isHighlighted) {
                b.tvContent.background?.colorFilter = android.graphics.PorterDuffColorFilter(0x44FFD600.toInt(), android.graphics.PorterDuff.Mode.SRC_ATOP)
            } else {
                b.tvContent.background?.colorFilter = null
            }

            b.root.setOnLongClickListener {
                onMessageLongClick?.invoke(msg)
                true
            }
        }
    }

    inner class OtherViewHolder(private val b: ItemMessageOtherBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(msg: Message, position: Int) {
            b.tvName.setTextColor(ThemeManager.getPrimaryColor(b.root.context))
            if (msg.receiver == null) {
                b.tvName.visibility = View.VISIBLE
                b.ivAvatar.visibility = View.VISIBLE
                b.tvName.text = "${msg.nickname ?: msg.name} (@${msg.name})"
                bindAvatar(msg.avatar, b.ivAvatar)
            } else {
                b.tvName.visibility = View.GONE
                b.ivAvatar.visibility = View.GONE
            }
            bindMessageContent(msg, msg.content, msg.isRecalled == 1, b.tvContent, b.ivImage, 0xFF212121.toInt())
            b.tvTime.text = messageStatusText(msg, false)

            b.ivAvatar.setOnClickListener {
                onAvatarClick?.invoke(msg)
            }

            setupTextSelection(b.tvContent, msg, false)

            // Quote positioning click listener
            if (!msg.reply.isNullOrEmpty() && msg.isRecalled != 1) {
                val parentId = msg.reply.toIntOrNull()
                if (parentId != null) {
                    b.tvContent.setOnClickListener {
                        onReplyQuoteClick?.invoke(parentId)
                    }
                }
            }

            // Highlight overlay
            val isHighlighted = position == highlightedPosition
            if (isHighlighted) {
                b.tvContent.background?.colorFilter = android.graphics.PorterDuffColorFilter(0x44FFD600.toInt(), android.graphics.PorterDuff.Mode.SRC_ATOP)
            } else {
                b.tvContent.background?.colorFilter = null
            }

            b.root.setOnLongClickListener {
                onMessageLongClick?.invoke(msg)
                true
            }
        }
    }

    private fun messageStatusText(msg: Message, isSelf: Boolean): String {
        val parts = mutableListOf<String>()
        if (!msg.time.isNullOrBlank()) parts.add(msg.time)
        if (msg.edited || msg.editedAt != null) parts.add("已编辑")
        if (isSelf && msg.deliveryStatus == "sending") parts.add("发送中")
        if (isSelf && msg.deliveryStatus == "failed") parts.add("发送失败")
        if (isSelf && msg.id > 0) {
            parts.add(if (msg.readCount > 0) "${msg.readCount}人已读" else "未读")
        }
        return parts.joinToString(" · ")
    }

    private fun setupTextSelection(tvContent: TextView, msg: Message, isSelf: Boolean) {
        if (msg.isRecalled == 1 || msg.content == "[system_recalled]" || msg.content == "[Message recalled]" || msg.content.startsWith("[img:") || msg.content.startsWith("[file:")) {
            tvContent.setTextIsSelectable(false)
            tvContent.customSelectionActionModeCallback = null
            return
        }

        tvContent.setTextIsSelectable(true)
        tvContent.customSelectionActionModeCallback = object : android.view.ActionMode.Callback {
            override fun onCreateActionMode(mode: android.view.ActionMode?, menu: android.view.Menu?): Boolean {
                if (menu == null) return true
                menu.add(0, 101, 10, "回复")
                menu.add(0, 102, 11, "转发")
                menu.add(0, 103, 12, "翻译")
                if (isSelf && msg.canRecall) {
                    menu.add(0, 104, 13, "撤回")
                }
                return true
            }

            override fun onPrepareActionMode(mode: android.view.ActionMode?, menu: android.view.Menu?): Boolean = false

            override fun onActionItemClicked(mode: android.view.ActionMode?, item: android.view.MenuItem?): Boolean {
                if (item == null) return false
                val start = tvContent.selectionStart.coerceAtLeast(0)
                val end = tvContent.selectionEnd.coerceAtLeast(0)
                val selectedText = if (start < end) {
                    tvContent.text.substring(start, end).toString()
                } else {
                    tvContent.text.toString()
                }

                when (item.itemId) {
                    101 -> {
                        onActionOptionClick?.invoke("回复 (引用)", msg, selectedText)
                        mode?.finish()
                        return true
                    }
                    102 -> {
                        onActionOptionClick?.invoke("转发消息", msg, selectedText)
                        mode?.finish()
                        return true
                    }
                    103 -> {
                        onActionOptionClick?.invoke("翻译消息", msg, selectedText)
                        mode?.finish()
                        return true
                    }
                    104 -> {
                        onActionOptionClick?.invoke("撤回消息", msg, selectedText)
                        mode?.finish()
                        return true
                    }
                }
                return false
            }

            override fun onDestroyActionMode(mode: android.view.ActionMode?) {}
        }
    }

    private fun checkAndSaveImage(context: android.content.Context, bitmap: android.graphics.Bitmap) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q &&
            androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            if (context is androidx.appcompat.app.AppCompatActivity) {
                androidx.core.app.ActivityCompat.requestPermissions(
                    context,
                    arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE),
                    1001
                )
                Toast.makeText(context, "请授予存储权限后重新点击保存", Toast.LENGTH_LONG).show()
            } else {
                Toast.makeText(context, "无存储权限，无法保存图片", Toast.LENGTH_SHORT).show()
            }
        } else {
            saveImageToGallery(context, bitmap)
        }
    }

    private fun saveImageToGallery(context: android.content.Context, bitmap: android.graphics.Bitmap) {
        val filename = "IMG_${System.currentTimeMillis()}.jpg"
        var fos: java.io.OutputStream? = null
        val contentValues = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, filename)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/OpenBoard")
                put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }
        
        val contentResolver = context.contentResolver
        val imageUri = contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
        
        if (imageUri != null) {
            try {
                fos = contentResolver.openOutputStream(imageUri)
                if (fos != null) {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 100, fos)
                    fos.flush()
                    Toast.makeText(context, "图片已保存至相册", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(context, "保存失败: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                try {
                    fos?.close()
                } catch (e: Exception) {}
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    contentValues.clear()
                    contentValues.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
                    contentResolver.update(imageUri, contentValues, null, null)
                }
            }
        } else {
            Toast.makeText(context, "无法保存图片", Toast.LENGTH_SHORT).show()
        }
    }
}
