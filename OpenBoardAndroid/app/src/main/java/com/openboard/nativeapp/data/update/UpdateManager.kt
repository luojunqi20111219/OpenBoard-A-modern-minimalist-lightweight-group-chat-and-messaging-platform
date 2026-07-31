package com.openboard.nativeapp.data.update

import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import android.view.LayoutInflater
import android.widget.*
import androidx.core.content.FileProvider
import com.google.gson.JsonObject
import com.openboard.nativeapp.data.api.RetrofitClient
import com.openboard.nativeapp.data.local.SessionManager
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

object UpdateManager {

    private const val TAG = "UpdateManager"
    private const val PREF_MIRROR_KEY = "custom_github_mirror"

    // Default GitHub Mirror candidate list for automatic speed testing
    val MIRROR_CANDIDATES = listOf(
        "Direct (GitHub 官方)" to "https://github.com/",
        "GhProxy 节点 1" to "https://ghproxy.net/",
        "GhProxy 节点 2" to "https://mirror.ghproxy.com/",
        "GitMirror 节点" to "https://hub.gitmirror.com/",
        "KKGitHub 节点" to "https://kkgithub.com/"
    )

    fun getSelectedMirror(context: Context): String {
        val prefs = context.getSharedPreferences("update_prefs", Context.MODE_PRIVATE)
        return prefs.getString(PREF_MIRROR_KEY, "https://ghproxy.net/") ?: "https://ghproxy.net/"
    }

    fun setSelectedMirror(context: Context, mirrorUrl: String) {
        val prefs = context.getSharedPreferences("update_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString(PREF_MIRROR_KEY, mirrorUrl).apply()
    }

    /**
     * Auto speed-test among mirror candidates and pick the fastest one with lowest latency
     */
    fun testMirrorsSpeed(context: Context, onResult: (fastestName: String, fastestUrl: String, latencyMs: Long) -> Unit) {
        CoroutineScope(Dispatchers.IO).launch {
            val client = OkHttpClient.Builder()
                .connectTimeout(3, TimeUnit.SECONDS)
                .readTimeout(3, TimeUnit.SECONDS)
                .build()

            var bestUrl = "https://ghproxy.net/"
            var bestName = "GhProxy 节点 1"
            var bestLatency = Long.MAX_VALUE

            for ((name, prefix) in MIRROR_CANDIDATES) {
                val testTarget = if (prefix == "https://github.com/") "https://github.com" else "${prefix}https://github.com"
                val startTime = System.currentTimeMillis()
                try {
                    val req = Request.Builder().url(testTarget).head().build()
                    val resp = client.newCall(req).execute()
                    val duration = System.currentTimeMillis() - startTime
                    if (resp.isSuccessful || resp.code < 500) {
                        Log.i(TAG, "Mirror $name ($prefix) latency: ${duration}ms")
                        if (duration < bestLatency) {
                            bestLatency = duration
                            bestUrl = prefix
                            bestName = name
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Mirror $name failed: ${e.message}")
                }
            }

            if (bestLatency == Long.MAX_VALUE) {
                bestLatency = 999
            }

            setSelectedMirror(context, bestUrl)
            withContext(Dispatchers.Main) {
                onResult(bestName, bestUrl, bestLatency)
            }
        }
    }

    /**
     * Check update from server API
     */
    fun checkUpdate(context: Context, isAutoCheck: Boolean = false) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val apiService = RetrofitClient.getApiService()
                val response = apiService.checkUpdate().execute()
                if (response.isSuccessful && response.body() != null) {
                    val body = response.body()!!
                    if (body.status == "success") {
                        val latestVersion = body.latest ?: "v8.0.0"
                        val rawDownloadUrl = body.downloadUrl ?: "https://github.com/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/releases/download/v8.0.0/app-debug.apk"
                        val changelog = body.body ?: "OpenBoard V8.0.0 跨平台全套更新上线！"
                        
                        // Compare version
                        val currentVersion = getAppVersionName(context)
                        val hasUpdate = compareVersions(latestVersion.replace("v", ""), currentVersion.replace("v", "")) > 0

                        withContext(Dispatchers.Main) {
                            if (hasUpdate) {
                                showUpdateDialog(context, latestVersion, changelog, rawDownloadUrl)
                            } else if (!isAutoCheck) {
                                Toast.makeText(context, "当前已是最新版本 ($currentVersion)", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                } else if (!isAutoCheck) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(context, "检查更新失败，请稍后重试", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Check update error", e)
                if (!isAutoCheck) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(context, "网络连线异常: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    private fun showUpdateDialog(context: Context, version: String, notes: String, rawDownloadUrl: String) {
        val builder = AlertDialog.Builder(context)
        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 40, 50, 20)
        }

        val tvTitle = TextView(context).apply {
            text = "🚀 发现新版本 $version"
            textSize = 20f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setTextColor(0xFF1565C0.toInt())
            setPadding(0, 0, 0, 20)
        }

        val tvNotes = TextView(context).apply {
            text = "【更新说明】\n$notes"
            textSize = 14f
            setTextColor(0xFF333333.toInt())
            setPadding(0, 0, 0, 20)
        }

        val tvMirrorLabel = TextView(context).apply {
            text = "🌐 当前镜像节点 (支持自动测速与自定义):"
            textSize = 12f
            setTextColor(0xFF666666.toInt())
        }

        val etMirror = EditText(context).apply {
            setText(getSelectedMirror(context))
            textSize = 13f
        }

        val btnSpeedTest = Button(context).apply {
            text = "⚡ 节点后台自动测速"
            textSize = 12f
            setOnClickListener {
                text = "⏳ 正在测速中..."
                isEnabled = false
                testMirrorsSpeed(context) { bestName, bestUrl, latency ->
                    etMirror.setText(bestUrl)
                    text = "⚡ 最快: $bestName (${latency}ms)"
                    isEnabled = true
                    Toast.makeText(context, "已自动选择最快节点: $bestName (${latency}ms)", Toast.LENGTH_SHORT).show()
                }
            }
        }

        layout.addView(tvTitle)
        layout.addView(tvNotes)
        layout.addView(tvMirrorLabel)
        layout.addView(etMirror)
        layout.addView(btnSpeedTest)

        builder.setView(layout)
        builder.setPositiveButton("🚀 立即更新下载") { dialog, _ ->
            val selectedMirror = etMirror.text.toString().trim()
            setSelectedMirror(context, selectedMirror)
            val finalUrl = applyMirror(rawDownloadUrl, selectedMirror)
            downloadAndInstallApk(context, finalUrl)
            dialog.dismiss()
        }
        builder.setNegativeButton("稍后再说") { dialog, _ ->
            dialog.dismiss()
        }

        builder.create().show()
    }

    private fun applyMirror(downloadUrl: String, mirrorPrefix: String): String {
        if (mirrorPrefix.isBlank() || mirrorPrefix == "https://github.com/") return downloadUrl
        val cleanPrefix = if (mirrorPrefix.endsWith("/")) mirrorPrefix else "$mirrorPrefix/"
        return if (downloadUrl.startsWith("https://github.com/")) {
            "${cleanPrefix}$downloadUrl"
        } else {
            downloadUrl
        }
    }

    private fun downloadAndInstallApk(context: Context, downloadUrl: String) {
        val progressDialog = ProgressDialog(context).apply {
            setTitle("正在下载更新包")
            setMessage("正在下载新版本 APK，请稍候...")
            setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
            max = 100
            setCancelable(false)
            show()
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .build()

                val req = Request.Builder().url(downloadUrl).build()
                val resp = client.newCall(req).execute()

                if (!resp.isSuccessful) {
                    withContext(Dispatchers.Main) {
                        progressDialog.dismiss()
                        Toast.makeText(context, "下载失败 (HTTP ${resp.code})，正在尝试备用镜像下载...", Toast.LENGTH_LONG).show()
                        // Fallback speed test automatically
                        testMirrorsSpeed(context) { _, bestUrl, _ ->
                            val fallbackUrl = applyMirror(downloadUrl, bestUrl)
                            downloadAndInstallApk(context, fallbackUrl)
                        }
                    }
                    return@launch
                }

                val body = resp.body ?: throw Exception("Empty response body")
                val totalLength = body.contentLength()
                val apkFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "OpenBoard_v8.0.0.apk")

                val input = body.byteStream()
                val output = FileOutputStream(apkFile)
                val buffer = ByteArray(8192)
                var read: Int
                var downloaded: Long = 0

                while (input.read(buffer).also { read = it } != -1) {
                    output.write(buffer, 0, read)
                    downloaded += read
                    if (totalLength > 0) {
                        val progress = ((downloaded * 100) / totalLength).toInt()
                        withContext(Dispatchers.Main) {
                            progressDialog.progress = progress
                        }
                    }
                }

                output.flush()
                output.close()
                input.close()

                withContext(Dispatchers.Main) {
                    progressDialog.dismiss()
                    installApk(context, apkFile)
                }

            } catch (e: Exception) {
                Log.e(TAG, "Download APK failed", e)
                withContext(Dispatchers.Main) {
                    progressDialog.dismiss()
                    Toast.makeText(context, "下载中断: ${e.message}，正在尝试自动切换镜像...", Toast.LENGTH_SHORT).show()
                    testMirrorsSpeed(context) { _, bestUrl, _ ->
                        val fallbackUrl = applyMirror(downloadUrl, bestUrl)
                        downloadAndInstallApk(context, fallbackUrl)
                    }
                }
            }
        }
    }

    private fun installApk(context: Context, apkFile: File) {
        if (!apkFile.exists()) return
        val intent = Intent(Intent.ACTION_VIEW)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val apkUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive")
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else {
            intent.setDataAndType(Uri.fromFile(apkFile), "application/vnd.android.package-archive")
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun getAppVersionName(context: Context): String {
        return try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            info.versionName ?: "8.0.0"
        } catch (e: Exception) {
            "8.0.0"
        }
    }

    private fun compareVersions(v1: String, v2: String): Int {
        val p1 = v1.split(".").mapNotNull { it.toIntOrNull() }
        val p2 = v2.split(".").mapNotNull { it.toIntOrNull() }
        val maxLen = maxOf(p1.size, p2.size)
        for (i in 0 until maxLen) {
            val num1 = p1.getOrElse(i) { 0 }
            val num2 = p2.getOrElse(i) { 0 }
            if (num1 != num2) {
                return num1.compareTo(num2)
            }
        }
        return 0
    }
}
