package com.openboard.nativeapp.ui.main

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.FragmentProfileBinding
import com.openboard.nativeapp.ui.theme.ThemeManager
import com.openboard.nativeapp.ui.theme.ThemePickerActivity
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import android.widget.ImageView
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder

/**
 * 个人资料中心，提供昵称修改、Base64 头像上传、安全密码更改、账号注销与登出等功能。
 */
class ProfileFragment : Fragment() {
    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()

    // 注册系统相册选择器回调
    private val pickAvatarLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let { processAndUploadAvatar(it) }
    }

    private val themePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            requireActivity().recreate()
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupUI()
        loadUserProfile()
        applyTheme()
    }

    private fun applyTheme() {
        ThemeManager.applyToHeader(requireContext(), binding.toolbar, binding.headerLayout)
    }

    /**
     * 初始化事件监听与基本设置
     */
    private fun setupUI() {
        binding.toolbar.title = "设置"

        // 个性化主题按钮点击
        binding.btnTheme.setOnClickListener {
            themePickerLauncher.launch(Intent(requireContext(), ThemePickerActivity::class.java))
        }

        // 我的二维码名片点击
        binding.btnQrCode.setOnClickListener {
            showMyQrCodeDialog()
        }

        // 修改头像点击
        binding.ivAvatar.setOnClickListener {
            pickAvatarLauncher.launch("image/*")
        }

        // 修改昵称点击
        binding.tvNickname.setOnClickListener {
            showEditNicknameDialog()
        }

        // 修改密码按钮
        binding.btnChangePassword.setOnClickListener {
            doChangePassword()
        }

        // 黑名单管理按钮
        binding.btnBlacklist.setOnClickListener {
            showBlacklistDialog()
        }

        // 登出按钮
        binding.btnLogout.setOnClickListener {
            (activity as? MainActivity)?.logout()
        }

        // 注销账号按钮
        binding.btnDeleteAccount.setOnClickListener {
            showDeleteAccountConfirmation()
        }

        // 官方账号禁用注销
        if (SessionManager.username == "官方账号") {
            binding.btnDeleteAccount.visibility = View.GONE
        }
    }

    /**
     * 载入本地缓存的用户头像与昵称数据并渲染
     */
    private fun loadUserProfile() {
        binding.tvUsername.text = "@${SessionManager.username}"
        binding.tvNickname.text = SessionManager.nickname ?: "未设置昵称"

        val avatarStr = SessionManager.avatar
        if (!avatarStr.isNullOrEmpty()) {
            try {
                val base64Data = if (avatarStr.startsWith("data:image")) {
                    avatarStr.substringAfter("base64,")
                } else {
                    avatarStr
                }
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                binding.ivAvatar.setImageBitmap(bmp)
            } catch (e: Exception) {
                binding.ivAvatar.setImageResource(R.drawable.ic_person)
            }
        } else {
            binding.ivAvatar.setImageResource(R.drawable.ic_person)
        }
    }

    /**
     * 处理相册选取的图片，执行必要的压缩并转换为 Base64 字符串上传
     */
    private fun processAndUploadAvatar(uri: Uri) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val inputStream = requireContext().contentResolver.openInputStream(uri)
                val rawBytes = inputStream?.readBytes()
                inputStream?.close()

                if (rawBytes != null) {
                    var bmp = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)
                    
                    // 若图片过大，对其进行等比缩放和压缩以节省流量与后端存储
                    if (rawBytes.size > 150 * 1024) {
                        val outputStream = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.JPEG, 60, outputStream)
                        val compressedBytes = outputStream.toByteArray()
                        bmp = BitmapFactory.decodeByteArray(compressedBytes, 0, compressedBytes.size)
                    }
                    
                    val out = ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
                    val base64Str = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                    
                    // 调用 API 更新个人头像
                    val result = repository.updateProfile(
                        nickname = SessionManager.nickname ?: SessionManager.username ?: "",
                        avatar = base64Str
                    )
                    
                    binding.progressBar.visibility = View.GONE
                    result.onSuccess {
                        SessionManager.avatar = base64Str
                        loadUserProfile()
                        Toast.makeText(requireContext(), "头像更新成功", Toast.LENGTH_SHORT).show()
                    }.onFailure { e ->
                        Toast.makeText(requireContext(), "头像上传失败: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                } else {
                    binding.progressBar.visibility = View.GONE
                }
            } catch (e: Exception) {
                binding.progressBar.visibility = View.GONE
                Toast.makeText(requireContext(), "头像处理失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 弹出修改昵称对话框
     */
    private fun showEditNicknameDialog() {
        val editText = EditText(requireContext()).apply {
            setText(SessionManager.nickname)
            setSelection(text.length)
        }

        AlertDialog.Builder(requireContext())
            .setTitle("修改昵称")
            .setView(editText)
            .setPositiveButton("保存") { dialog, _ ->
                val newNickname = editText.text.toString().trim()
                if (newNickname.isEmpty()) {
                    Toast.makeText(requireContext(), "昵称不能为空", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                updateNickname(newNickname)
                dialog.dismiss()
            }
            .setNegativeButton("取消") { dialog, _ ->
                dialog.dismiss()
            }
            .show()
    }

    /**
     * 发送网络请求更新昵称
     */
    private fun updateNickname(name: String) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.updateProfile(name, SessionManager.avatar)
            binding.progressBar.visibility = View.GONE
            result.onSuccess {
                SessionManager.nickname = name
                loadUserProfile()
                Toast.makeText(requireContext(), "昵称修改成功", Toast.LENGTH_SHORT).show()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "修改昵称失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 异步更新密码
     */
    private fun doChangePassword() {
        val oldPwd = binding.pwdOld.text.toString()
        val newPwd = binding.pwdNew.text.toString()

        if (oldPwd.isEmpty() || newPwd.isEmpty()) {
            Toast.makeText(requireContext(), "密码框不能为空", Toast.LENGTH_SHORT).show()
            return
        }

        binding.progressBar.visibility = View.VISIBLE
        binding.btnChangePassword.isEnabled = false

        lifecycleScope.launch {
            val result = repository.updatePassword(oldPwd, newPwd)
            binding.progressBar.visibility = View.GONE
            binding.btnChangePassword.isEnabled = true
            result.onSuccess {
                binding.pwdOld.text.clear()
                binding.pwdNew.text.clear()
                Toast.makeText(requireContext(), "密码修改成功", Toast.LENGTH_SHORT).show()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "修改密码失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * 弹出账号永久注销的警告确认弹窗
     */
    private fun showDeleteAccountConfirmation() {
        AlertDialog.Builder(requireContext())
            .setTitle("⚠️ 危险操作：永久注销账号")
            .setMessage("一旦注销，您发送的所有历史消息和创建的所有群组都会被彻底清除，此操作不可逆。确定继续吗？")
            .setPositiveButton("确定注销") { dialog, _ ->
                doDeleteAccount()
                dialog.dismiss()
            }
            .setNegativeButton("取消") { dialog, _ ->
                dialog.dismiss()
            }
            .show()
    }

    /**
     * 执行注销账号的 API 请求
     */
    private fun doDeleteAccount() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.deleteAccount()
            binding.progressBar.visibility = View.GONE
            result.onSuccess {
                Toast.makeText(requireContext(), "账号注销成功", Toast.LENGTH_SHORT).show()
                (activity as? MainActivity)?.logout()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "注销失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showBlacklistDialog() {
        val blockedUsers = SessionManager.blockedUsers.toList()
        if (blockedUsers.isEmpty()) {
            Toast.makeText(requireContext(), "黑名单为空", Toast.LENGTH_SHORT).show()
            return
        }
        
        AlertDialog.Builder(requireContext())
            .setTitle("已拉黑用户名单 (点击解黑)")
            .setItems(blockedUsers.toTypedArray()) { _, which ->
                val targetUser = blockedUsers[which]
                AlertDialog.Builder(requireContext())
                    .setTitle("提示")
                    .setMessage("确定要取消拉黑用户 @${targetUser} 吗？")
                    .setPositiveButton("确定") { _, _ ->
                        binding.progressBar.visibility = View.VISIBLE
                        lifecycleScope.launch {
                            val result = repository.blockUser(targetUser)
                            binding.progressBar.visibility = View.GONE
                            result.onSuccess { resp ->
                                val currentBlocked = SessionManager.blockedUsers.toMutableSet()
                                if (resp.isBlocked) {
                                    currentBlocked.add(targetUser)
                                } else {
                                    currentBlocked.remove(targetUser)
                                }
                                SessionManager.blockedUsers = currentBlocked
                                Toast.makeText(requireContext(), "已取消拉黑 @${targetUser}", Toast.LENGTH_SHORT).show()
                                if (currentBlocked.isNotEmpty()) {
                                    showBlacklistDialog()
                                }
                            }.onFailure { e ->
                                Toast.makeText(requireContext(), "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                    .setNegativeButton("取消") { d, _ ->
                        d.dismiss()
                        showBlacklistDialog()
                    }
                    .show()
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    private fun showMyQrCodeDialog() {
        val username = SessionManager.username ?: ""
        if (username.isEmpty()) return
        val encodedUsername = java.net.URLEncoder.encode(username, "UTF-8")
        val qrContent = "openboard:add_friend:$encodedUsername"
        
        try {
            val hints = mapOf(com.google.zxing.EncodeHintType.CHARACTER_SET to "UTF-8")
            val writer = com.google.zxing.MultiFormatWriter()
            val bitMatrix = writer.encode(qrContent, BarcodeFormat.QR_CODE, 500, 500, hints)
            val barcodeEncoder = BarcodeEncoder()
            val bitmap = barcodeEncoder.createBitmap(bitMatrix)
            
            val imageView = ImageView(requireContext()).apply {
                setImageBitmap(bitmap)
                val pad = 48
                setPadding(pad, pad, pad, pad)
            }
            
            AlertDialog.Builder(requireContext())
                .setTitle("我的二维码名片")
                .setMessage("让好友使用 OpenBoard 扫一扫添加您")
                .setView(imageView)
                .setPositiveButton("确定", null)
                .show()
        } catch (e: Exception) {
            Toast.makeText(requireContext(), "生成二维码失败", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
