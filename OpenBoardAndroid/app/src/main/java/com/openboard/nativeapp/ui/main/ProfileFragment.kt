package com.openboard.nativeapp.ui.main

import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.local.SessionManager
import com.openboard.nativeapp.data.repository.ChatRepository
import com.openboard.nativeapp.databinding.FragmentProfileBinding
import kotlinx.coroutines.launch

class ProfileFragment : Fragment() {
    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!
    private val repository = ChatRepository()

    private val pickAvatar = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { updateAvatar(it) }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.toolbar.title = "个人资料"
        binding.toolbar.setNavigationOnClickListener {
            (activity as? MainActivity)?.loadFragment(ChatListFragment())
        }

        loadProfileData()

        binding.ivAvatar.setOnClickListener {
            pickAvatar.launch("image/*")
        }

        binding.tvNickname.setOnClickListener {
            showEditNicknameDialog()
        }

        binding.btnChangePassword.setOnClickListener {
            showChangePasswordDialog()
        }

        binding.btnDeleteAccount.setOnClickListener {
            showDeleteAccountDialog()
        }

        binding.btnLogout.setOnClickListener {
            (activity as? MainActivity)?.logout()
        }
    }

    private fun loadProfileData() {
        val user = SessionManager.getUser()
        binding.tvUsername.text = "@${user.username}"
        binding.tvNickname.text = user.nickname ?: "设置昵称"

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
                binding.ivAvatar.setImageBitmap(bmp)
            } catch (e: Exception) {
                binding.ivAvatar.setImageResource(R.drawable.ic_person)
            }
        } else {
            binding.ivAvatar.setImageResource(R.drawable.ic_person)
        }
    }

    private fun updateAvatar(uri: Uri) {
        binding.progressBar.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val inputStream = requireContext().contentResolver.openInputStream(uri) ?: return@launch
                val bytes = inputStream.readBytes()
                inputStream.close()

                // Downscale image to keep Base64 size compact for SQLite text field
                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                val out = java.io.ByteArrayOutputStream()
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                val compressedBytes = out.toByteArray()

                val base64 = Base64.encodeToString(compressedBytes, Base64.NO_WRAP)
                val base64Header = "data:image/jpeg;base64,$base64"

                val result = repository.updateProfile(
                    SessionManager.nickname ?: SessionManager.username ?: "",
                    base64Header
                )
                binding.progressBar.visibility = View.GONE
                result.onSuccess {
                    SessionManager.avatar = base64Header
                    loadProfileData()
                    Toast.makeText(requireContext(), "头像更新成功！", Toast.LENGTH_SHORT).show()
                }.onFailure {
                    Toast.makeText(requireContext(), "更新失败: ${it.message}", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                binding.progressBar.visibility = View.GONE
                Toast.makeText(requireContext(), "图片读取失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showEditNicknameDialog() {
        val input = EditText(requireContext()).apply {
            setText(SessionManager.nickname)
            setSelection(text.length)
        }
        val layout = LinearLayout(requireContext()).apply {
            setPadding(40, 20, 40, 20)
            addView(input, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        AlertDialog.Builder(requireContext())
            .setTitle("修改昵称")
            .setView(layout)
            .setPositiveButton("保存") { _, _ ->
                val newNick = input.text.toString().trim()
                if (newNick.isNotEmpty()) {
                    binding.progressBar.visibility = View.VISIBLE
                    lifecycleScope.launch {
                        val result = repository.updateProfile(newNick, SessionManager.avatar)
                        binding.progressBar.visibility = View.GONE
                        result.onSuccess {
                            SessionManager.nickname = newNick
                            loadProfileData()
                            Toast.makeText(requireContext(), "昵称已更新", Toast.LENGTH_SHORT).show()
                        }.onFailure {
                            Toast.makeText(requireContext(), "更新失败: ${it.message}", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showChangePasswordDialog() {
        val oldPwdInput = EditText(requireContext()).apply {
            hint = "旧密码"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val newPwdInput = EditText(requireContext()).apply {
            hint = "新密码"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val layout = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
            addView(oldPwdInput, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            addView(newPwdInput, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        AlertDialog.Builder(requireContext())
            .setTitle("修改密码")
            .setView(layout)
            .setPositiveButton("更新") { _, _ ->
                val old = oldPwdInput.text.toString()
                val new = newPwdInput.text.toString()
                if (old.isNotEmpty() && new.isNotEmpty()) {
                    binding.progressBar.visibility = View.VISIBLE
                    lifecycleScope.launch {
                        val result = repository.updatePassword(old, new)
                        binding.progressBar.visibility = View.GONE
                        result.onSuccess {
                            Toast.makeText(requireContext(), "密码修改成功！", Toast.LENGTH_SHORT).show()
                        }.onFailure {
                            Toast.makeText(requireContext(), "修改失败: ${it.message}", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showDeleteAccountDialog() {
        AlertDialog.Builder(requireContext())
            .setTitle("永久注销账户")
            .setMessage("您确定要永久注销该账户吗？此操作无法撤销，所有数据都将被清除。")
            .setPositiveButton("注销") { _, _ ->
                binding.progressBar.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val result = repository.deleteAccount()
                    binding.progressBar.visibility = View.GONE
                    result.onSuccess {
                        Toast.makeText(requireContext(), "您的账户已成功注销", Toast.LENGTH_LONG).show()
                        (activity as? MainActivity)?.logout()
                    }.onFailure {
                        Toast.makeText(requireContext(), "注销失败: ${it.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
