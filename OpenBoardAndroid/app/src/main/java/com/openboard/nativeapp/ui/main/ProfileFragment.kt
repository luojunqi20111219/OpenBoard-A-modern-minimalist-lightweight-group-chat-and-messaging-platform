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

        // 登录设备与账号安全管理
        binding.btnDevices.setOnClickListener {
            showDevicesDialog()
        }

        // 休闲小游戏中心
        binding.btnGame.setOnClickListener {
            startActivity(Intent(requireContext(), com.openboard.nativeapp.ui.game.GameWebActivity::class.java))
        }

        // 检查系统软件更新
        binding.btnCheckUpdate.setOnClickListener {
            com.openboard.nativeapp.data.update.UpdateManager.checkUpdate(requireContext(), isAutoCheck = false)
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

        // 管理员相关入口 —— 状态由服务端决定，不信任本地角色
        binding.btnAdminRequests.setOnClickListener { showAdminRequestsDialog() }
        binding.btnAdminPanel.setOnClickListener { showAdminListDialog() }
        binding.btnApplyAdmin.setOnClickListener { confirmApplyAdmin() }
        loadAdminState()
    }

    /**
     * 查询"我是不是管理员 / 我有没有在等审批"。
     *
     * 这个判断必须问服务端，不能用本地 SessionManager 里的 role ——
     * 动态授予的管理权限存在 D1，本地缓存里根本没有这个信息。
     *
     * 三种状态：
     *   · 已是管理员  → 显示「待处理申请」「管理员名单」
     *   · 有 pending  → 显示"等待审批中"的提示，不给重复申请
     *   · 都不是      → 显示「申请成为管理员」
     *
     * 接口失败（比如老版本后端）时三个控件全隐藏，静默降级 ——
     * 不打扰正常用户。
     */
    private fun loadAdminState() {
        lifecycleScope.launch {
            val result = repository.getMyAdminApplication()
            result.onSuccess { resp ->
                if (resp.isAdmin) {
                    binding.boxAdmin.visibility = View.VISIBLE
                    binding.btnApplyAdmin.visibility = View.GONE
                    refreshPendingBadge()
                } else if (resp.pending != null) {
                    binding.boxAdmin.visibility = View.GONE
                    binding.btnApplyAdmin.visibility = View.GONE
                } else {
                    binding.boxAdmin.visibility = View.GONE
                    binding.btnApplyAdmin.visibility = View.VISIBLE
                }
            }.onFailure {
                binding.boxAdmin.visibility = View.GONE
                binding.btnApplyAdmin.visibility = View.GONE
            }
        }
    }

    /** 待处理申请的数量直接写在按钮文案上，省得管理员每天去翻 */
    private fun refreshPendingBadge() {
        lifecycleScope.launch {
            repository.getAdminRequests("pending").onSuccess { list ->
                binding.btnAdminRequests.text =
                    if (list.isEmpty()) "待处理的管理员申请" else "待处理的管理员申请（${list.size}）"
            }
        }
    }

    // -----------------------------------------------------------------------
    // 申请成为管理员
    // -----------------------------------------------------------------------

    private fun confirmApplyAdmin() {
        val note = EditText(requireContext()).apply {
            hint = "简单说明你是谁、为什么要管理权限"
            minLines = 2
        }
        val wrap = android.widget.FrameLayout(requireContext()).apply {
            setPadding(48, 16, 48, 0)
            addView(note)
        }

        AlertDialog.Builder(requireContext())
            .setTitle("申请成为管理员")
            .setMessage(
                "提交后需要现有管理员批准才能生效。\n\n" +
                    "管理员可以封禁用户、重置他人密码、管理群聊 —— " +
                    "你的说明会展示给审批人，写清楚更容易通过。",
            )
            .setView(wrap)
            .setPositiveButton("提交申请") { _, _ ->
                val text = note.text.toString().trim()
                if (text.isEmpty()) {
                    Toast.makeText(requireContext(), "请填写申请说明", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                doApplyAdmin(text)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doApplyAdmin(note: String) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val device = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
            val result = repository.applyForAdmin(note, device)
            binding.progressBar.visibility = View.GONE
            result.onSuccess {
                AlertDialog.Builder(requireContext())
                    .setTitle("申请已提交")
                    .setMessage(
                        "请等待现有管理员批准。\n\n" +
                            "你可以随时在「设置」里查看状态 —— 批准后这里会出现管理入口。",
                    )
                    .setPositiveButton("好的", null)
                    .show()
                loadAdminState()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "提交失败：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    // -----------------------------------------------------------------------
    // 审批申请（管理员）
    // -----------------------------------------------------------------------

    private fun showAdminRequestsDialog() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.getAdminRequests("pending")
            binding.progressBar.visibility = View.GONE

            result.onSuccess { list ->
                if (list.isEmpty()) {
                    AlertDialog.Builder(requireContext())
                        .setTitle("待处理的管理员申请")
                        .setMessage("目前没有人申请。")
                        .setPositiveButton("知道了", null)
                        .show()
                    return@launch
                }

                // 每条申请渲染成「用户名 · 时间 · 说明」，点进去做批准/拒绝
                val items = list.map { r ->
                    buildString {
                        append(r.username)
                        append("  ")
                        append(friendlyTime(r.createdAt))
                        r.note?.takeIf { it.isNotBlank() }?.let { append("\n$it") }
                    }
                }.toTypedArray()

                AlertDialog.Builder(requireContext())
                    .setTitle("待处理的管理员申请（${list.size}）")
                    .setItems(items) { _, which -> showDecisionDialog(list[which]) }
                    .setNegativeButton("关闭", null)
                    .show()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "读取失败：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** 单条申请的批准 / 拒绝 */
    private fun showDecisionDialog(req: com.openboard.nativeapp.data.model.AdminRequest) {
        val detail = buildString {
            append("用户名：${req.username}\n")
            append("申请时间：${friendlyTime(req.createdAt)}\n")
            if (!req.deviceInfo.isNullOrBlank()) append("设备：${req.deviceInfo}\n")
            if (!req.note.isNullOrBlank()) append("\n说明：\n${req.note}")
            append("\n\n批准后该账号可以：\n")
            append("· 登录管理端 App\n")
            append("· 封禁其他用户、重置他人密码\n")
            append("· 继续授予或撤销其他人的管理权限\n\n")
            append("只在确认对方身份可信时才批准。")
        }

        AlertDialog.Builder(requireContext())
            .setTitle("处理申请：${req.username}")
            .setMessage(detail)
            .setPositiveButton("批准为管理员") { _, _ -> decideAdmin(req, approve = true) }
            .setNeutralButton("拒绝") { _, _ -> decideAdmin(req, approve = false) }
            .setNegativeButton("稍后再说", null)
            .show()
    }

    private fun decideAdmin(
        req: com.openboard.nativeapp.data.model.AdminRequest,
        approve: Boolean,
    ) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = if (approve) {
                repository.approveAdmin(req.username, req.id)
            } else {
                repository.rejectAdmin(req.username, req.id)
            }
            binding.progressBar.visibility = View.GONE
            result.onSuccess {
                Toast.makeText(
                    requireContext(),
                    if (approve) "已授予 ${req.username} 管理权限" else "已拒绝该申请",
                    Toast.LENGTH_SHORT,
                ).show()
                refreshPendingBadge()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "操作失败：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    // -----------------------------------------------------------------------
    // 管理员名单（管理员）
    // -----------------------------------------------------------------------

    private fun showAdminListDialog() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.getAdminList()
            binding.progressBar.visibility = View.GONE

            result.onSuccess { admins ->
                if (admins.isEmpty()) {
                    Toast.makeText(requireContext(), "管理员名单为空", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                val labels = admins.map { a ->
                    val tag = if (a.builtin) "（服务器保底）" else ""
                    val me = if (a.username == SessionManager.username) "  ← 你" else ""
                    "${a.username}$tag$me"
                }.toTypedArray()

                AlertDialog.Builder(requireContext())
                    .setTitle("管理员名单（${admins.size}）")
                    .setItems(labels) { _, which -> showAdminActionDialog(admins[which]) }
                    .setNegativeButton("关闭", null)
                    .show()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "读取失败：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showAdminActionDialog(entry: com.openboard.nativeapp.data.model.AdminEntry) {
        // 自己和保底名单不给撤销入口 —— 与客户端无关，服务端也会拦，这里只是少让人白点
        if (entry.username == SessionManager.username) {
            Toast.makeText(requireContext(), "这是你自己的账号", Toast.LENGTH_SHORT).show()
            return
        }
        if (entry.builtin) {
            AlertDialog.Builder(requireContext())
                .setTitle(entry.username)
                .setMessage(
                    "该账号在服务器的保底管理员名单里（wrangler.toml 的 ALLOWED_ADMINS）。\n\n" +
                        "这是「就算数据库出问题也还能进管理端」的兜底通道，因此不能在 App 里撤销。",
                )
                .setPositiveButton("知道了", null)
                .show()
            return
        }

        AlertDialog.Builder(requireContext())
            .setTitle("撤销 ${entry.username} 的管理权限")
            .setMessage("撤销后 TA 将无法登录管理端，也不能再执行任何管理操作。")
            .setPositiveButton("撤销") { _, _ ->
                binding.progressBar.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val r = repository.revokeAdmin(entry.username)
                    binding.progressBar.visibility = View.GONE
                    r.onSuccess {
                        Toast.makeText(requireContext(), "已撤销", Toast.LENGTH_SHORT).show()
                        refreshPendingBadge()
                    }.onFailure { e ->
                        Toast.makeText(requireContext(), "撤销失败：${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 把服务端 UTC 时间戳转成「3 分钟前」。
     *
     * ⚠️ 这里以前是自己实现的：`iso.removeSuffix("Z")` 之后交给 SimpleDateFormat 解析。
     * 那行 removeSuffix 抹掉了唯一的时区标记，导致 UTC 被当成本地时间解析，
     * 中国用户看到的所有时间都早了 8 小时。现在统一走 Time 工具，**先按 UTC 解析**。
     */
    private fun friendlyTime(iso: String?): String =
        com.openboard.nativeapp.ui.common.Time.friendlyTime(iso)

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

    private fun showDevicesDialog() {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repository.getUserDevices()
            binding.progressBar.visibility = View.GONE
            result.onSuccess { devices ->
                if (devices.isEmpty()) {
                    Toast.makeText(requireContext(), "暂无活跃登录设备", Toast.LENGTH_SHORT).show()
                    return@launch
                }
                val items = devices.map { d ->
                    val name = d["device_name"] as? String ?: "未知设备"
                    val isCurrent = d["is_current"] as? Boolean ?: false
                    val lastLogin = com.openboard.nativeapp.ui.common.Time.absoluteDateTime(d["last_login"] as? String)
                    "$name ${if (isCurrent) "(当前设备)" else ""}\n上次登录: ${lastLogin.ifBlank { "未知" }}"
                }.toTypedArray()

                AlertDialog.Builder(requireContext())
                    .setTitle("📱 已登录设备列表 (点击可下线)")
                    .setItems(items) { _, which ->
                        val selectedDevice = devices[which]
                        val deviceId = selectedDevice["device_id"] as? String ?: return@setItems
                        val isCurrent = selectedDevice["is_current"] as? Boolean ?: false

                        if (isCurrent) {
                            Toast.makeText(requireContext(), "无法下线当前设备，请使用退出登录", Toast.LENGTH_SHORT).show()
                            return@setItems
                        }

                        AlertDialog.Builder(requireContext())
                            .setTitle("确认下线设备")
                            .setMessage("确定要下线该设备吗？下线后该设备需重新登录。")
                            .setPositiveButton("确定下线") { _, _ ->
                                binding.progressBar.visibility = View.VISIBLE
                                lifecycleScope.launch {
                                    val res = repository.logoutDevice(deviceId)
                                    binding.progressBar.visibility = View.GONE
                                    res.onSuccess {
                                        Toast.makeText(requireContext(), "设备已强行下线", Toast.LENGTH_SHORT).show()
                                        showDevicesDialog()
                                    }.onFailure { e ->
                                        Toast.makeText(requireContext(), "下线失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            }
                            .setNegativeButton("取消", null)
                            .show()
                    }
                    .setNeutralButton("注销所有其他设备") { _, _ ->
                        val input = EditText(requireContext()).apply {
                            hint = "请输入登录密码进行验证"
                            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                        }
                        AlertDialog.Builder(requireContext())
                            .setTitle("安全验证")
                            .setView(input)
                            .setPositiveButton("一键下线其他所有设备") { _, _ ->
                                val pwd = input.text.toString().trim()
                                if (pwd.isNotEmpty()) {
                                    binding.progressBar.visibility = View.VISIBLE
                                    lifecycleScope.launch {
                                        val res = repository.logoutAllDevices(pwd)
                                        binding.progressBar.visibility = View.GONE
                                        res.onSuccess {
                                            Toast.makeText(requireContext(), "其他所有设备已强制下线", Toast.LENGTH_SHORT).show()
                                        }.onFailure { e ->
                                            Toast.makeText(requireContext(), "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                }
                            }
                            .setNegativeButton("取消", null)
                            .show()
                    }
                    .setNegativeButton("关闭", null)
                    .show()
            }.onFailure { e ->
                Toast.makeText(requireContext(), "获取设备列表失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
