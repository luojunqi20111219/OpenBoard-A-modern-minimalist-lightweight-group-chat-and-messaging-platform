package com.openboard.nativeapp.ui.game

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.openboard.nativeapp.R
import com.openboard.nativeapp.data.api.RetrofitClient

class GameWebActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Custom simple layout or programmatic UI
        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setBackgroundColor(0xFF1E1E2E.toInt())
        }

        val header = android.widget.RelativeLayout(this).apply {
            setPadding(32, 24, 32, 24)
            setBackgroundColor(0xFF181825.toInt())
        }

        val btnBack = TextView(this).apply {
            text = "‹ 返回"
            textSize = 18f
            setTextColor(0xFF89B4FA.toInt())
            setOnClickListener {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        }
        val backParams = android.widget.RelativeLayout.LayoutParams(
            android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT,
            android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            addRule(android.widget.RelativeLayout.ALIGN_PARENT_LEFT)
            addRule(android.widget.RelativeLayout.CENTER_VERTICAL)
        }
        header.addView(btnBack, backParams)

        val title = TextView(this).apply {
            text = "🎮 休闲小游戏"
            textSize = 18f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(0xFFCDD6F4.toInt())
        }
        val titleParams = android.widget.RelativeLayout.LayoutParams(
            android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT,
            android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            addRule(android.widget.RelativeLayout.CENTER_IN_PARENT)
        }
        header.addView(title, titleParams)

        val btnRefresh = TextView(this).apply {
            text = "刷新"
            textSize = 16f
            setTextColor(0xFFA6E3A1.toInt())
            setOnClickListener {
                webView.reload()
            }
        }
        val refreshParams = android.widget.RelativeLayout.LayoutParams(
            android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT,
            android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            addRule(android.widget.RelativeLayout.ALIGN_PARENT_RIGHT)
            addRule(android.widget.RelativeLayout.CENTER_VERTICAL)
        }
        header.addView(btnRefresh, refreshParams)

        layout.addView(header, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    url?.let { view?.loadUrl(it) }
                    return true
                }
            }
        }

        val gameUrl = "file:///android_asset/game/index.html"
        webView.loadUrl(gameUrl)

        layout.addView(webView, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1.0f
        ))

        setContentView(layout)
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
