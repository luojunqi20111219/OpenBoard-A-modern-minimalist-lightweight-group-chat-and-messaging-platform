package com.openboard.nativeapp.ui.theme

import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.openboard.nativeapp.databinding.ActivityThemePickerBinding
import java.io.File

/**
 * 主题选择界面：允许用户选择主色调与聊天背景，实时预览后一键应用
 */
class ThemePickerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityThemePickerBinding

    private var selectedPrimary: Int = 0
    private var selectedChatBg: Int = 0
    private var isCustomBgSelected = false
    private var selectedCustomBgPath: String? = null
 
    // 圆点 View 引用，用于切换"选中"状态
    private val primarySwatches = mutableListOf<View>()
    private val bgSwatches = mutableListOf<View>()

    private val pickBgLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let { handleCustomBgUri(it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityThemePickerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 读取当前主题
        selectedPrimary = ThemeManager.getPrimaryColor(this)
        selectedChatBg = ThemeManager.getChatBackground(this)
        isCustomBgSelected = ThemeManager.isCustomBackground(this)
        if (isCustomBgSelected) {
            selectedCustomBgPath = ThemeManager.getCustomBackgroundPath(this)
        }
 
        setupToolbar()
        buildColorGrid(
            grid = binding.gridPrimaryColors,
            colors = ThemeManager.PRIMARY_COLORS,
            names = ThemeManager.PRIMARY_NAMES,
            selectedColor = selectedPrimary,
            swatchList = primarySwatches
        ) { color ->
            selectedPrimary = color
            updatePreview()
        }
        buildColorGrid(
            grid = binding.gridChatBg,
            colors = ThemeManager.CHAT_BG_COLORS,
            names = ThemeManager.CHAT_BG_NAMES,
            selectedColor = if (isCustomBgSelected) -1 else selectedChatBg,
            swatchList = bgSwatches
        ) { color ->
            isCustomBgSelected = false
            selectedChatBg = color
            updatePreview()
        }
 
        updatePreview()
 
        binding.btnPickCustomBg.setOnClickListener {
            pickBgLauncher.launch("image/*")
        }

        binding.btnApply.setOnClickListener {
            ThemeManager.setPrimaryColor(this, selectedPrimary)
            if (isCustomBgSelected && selectedCustomBgPath != null) {
                if (selectedCustomBgPath!!.startsWith(cacheDir.absolutePath)) {
                    try {
                        val finalFile = File(filesDir, "custom_chat_bg.jpg")
                        File(selectedCustomBgPath!!).copyTo(finalFile, overwrite = true)
                        ThemeManager.setCustomBackground(this, finalFile.absolutePath)
                    } catch (e: Exception) {
                        Toast.makeText(this, "保存背景图片失败: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                } else {
                    ThemeManager.setCustomBackground(this, selectedCustomBgPath)
                }
            } else {
                ThemeManager.setCustomBackground(this, null)
                ThemeManager.setChatBackground(this, selectedChatBg)
            }
            Toast.makeText(this, "主题已应用 ✓", Toast.LENGTH_SHORT).show()
            setResult(RESULT_OK)
            finish()
        }
    }

    private fun setupToolbar() {
        binding.toolbar.title = "个性化主题"
        // Apply gradient
        binding.toolbar.background = ThemeManager.buildGradientDrawable(this)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        binding.toolbar.setNavigationOnClickListener { finish() }
    }

    /**
     * 动态生成颜色圆形 swatch 网格
     */
    private fun buildColorGrid(
        grid: GridLayout,
        colors: List<Int>,
        names: List<String>,
        selectedColor: Int,
        swatchList: MutableList<View>,
        onPick: (Int) -> Unit
    ) {
        grid.removeAllViews()
        swatchList.clear()
        val size = dpToPx(52)
        val margin = dpToPx(8)

        colors.forEachIndexed { index, color ->
            val container = android.widget.FrameLayout(this).apply {
                layoutParams = GridLayout.LayoutParams().apply {
                    width = size + margin * 2
                    height = size + margin * 2
                }
            }

            // 外圈（选中时显示）
            val ring = View(this).apply {
                layoutParams = android.widget.FrameLayout.LayoutParams(
                    size + dpToPx(6), size + dpToPx(6)
                ).also { it.gravity = android.view.Gravity.CENTER }
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setStroke(dpToPx(2), color)
                    setColor(Color.TRANSPARENT)
                }
                visibility = if (color == selectedColor) View.VISIBLE else View.INVISIBLE
            }

            // 颜色圆
            val swatch = ImageView(this).apply {
                layoutParams = android.widget.FrameLayout.LayoutParams(size, size).also {
                    it.gravity = android.view.Gravity.CENTER
                }
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                }
                contentDescription = names.getOrElse(index) { "" }
            }

            container.addView(ring)
            container.addView(swatch)
            swatchList.add(ring)

            container.setOnClickListener {
                // 取消所有旧选中
                swatchList.forEach { it.visibility = View.INVISIBLE }
                // 设置当前选中
                ring.visibility = View.VISIBLE
                onPick(color)
            }

            grid.addView(container)
        }
    }

    /**
     * 根据当前选择更新预览区
     */
    private fun updatePreview() {
        // 更新工具栏颜色
        val gradientD = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(selectedPrimary, ThemeManager.darken(selectedPrimary))
        ).apply { gradientType = GradientDrawable.LINEAR_GRADIENT }

        binding.previewToolbar.background = gradientD
        binding.toolbar.background = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(selectedPrimary, ThemeManager.darken(selectedPrimary))
        ).apply { gradientType = GradientDrawable.LINEAR_GRADIENT }

        // 更新聊天背景色或背景图
        if (isCustomBgSelected && selectedCustomBgPath != null) {
            try {
                val bitmap = BitmapFactory.decodeFile(selectedCustomBgPath)
                if (bitmap != null) {
                    binding.previewChatBg.background = BitmapDrawable(resources, bitmap)
                } else {
                    binding.previewChatBg.background = null
                    binding.previewChatBg.setBackgroundColor(selectedChatBg)
                }
            } catch (e: Exception) {
                binding.previewChatBg.background = null
                binding.previewChatBg.setBackgroundColor(selectedChatBg)
            }
        } else {
            binding.previewChatBg.background = null
            binding.previewChatBg.setBackgroundColor(selectedChatBg)
        }

        // 更新自己的气泡颜色
        val bubbleBg = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(selectedPrimary, ThemeManager.darken(selectedPrimary))
        ).apply {
            gradientType = GradientDrawable.LINEAR_GRADIENT
            cornerRadii = floatArrayOf(18f, 18f, 18f, 18f, 18f, 18f, 4f, 4f)
        }
        binding.previewBubbleSelf.background = bubbleBg

        // 更新应用按钮颜色
        val btnBg = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(selectedPrimary, ThemeManager.darken(selectedPrimary))
        ).apply {
            gradientType = GradientDrawable.LINEAR_GRADIENT
            cornerRadius = dpToPx(8).toFloat()
        }
        binding.btnApply.background = btnBg
    }

    private fun handleCustomBgUri(uri: Uri) {
        try {
            val inputStream = contentResolver.openInputStream(uri) ?: return
            val tempFile = File(cacheDir, "temp_custom_bg.jpg")
            tempFile.outputStream().use { outputStream ->
                inputStream.copyTo(outputStream)
            }
            selectedCustomBgPath = tempFile.absolutePath
            isCustomBgSelected = true
 
            // 取消所有背景色圆圈的选中状态
            bgSwatches.forEach { it.visibility = View.INVISIBLE }
 
            updatePreview()
        } catch (e: Exception) {
            Toast.makeText(this, "读取背景图片失败: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun dpToPx(dp: Int): Int =
        (dp * resources.displayMetrics.density).toInt()
}
