package net.ankio.qqpet

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/** Plays pet/game/<swf> full screen, like the desktop's game window; reports the minutes played when closed. */
class GameActivity : Activity() {
    private lateinit var web: WebView
    private val start = SystemClock.elapsedRealtime()
    private var windowId = -1

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        windowId = intent.getIntExtra("windowId", -1)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            // The page's 退出 calls window.close(), which a WebView ignores for a page it did not open by script.
            addJavascriptInterface(object {
                @JavascriptInterface
                fun close() = runOnUiThread { finish() }
            }, "QQPetGame")
            webViewClient = object : AssetClient(this@GameActivity) {
                override fun onPageFinished(view: WebView, url: String) = view.evaluateJavascript("window.close = () => QQPetGame.close()", null)
            }
        }
        setContentView(web)
        window.insetsController!!.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        web.loadUrl("$ORIGIN/game.html?swf=${android.net.Uri.encode(intent.getStringExtra("swf"))}")
    }

    // The pet overlay would cover the game.
    override fun onStart() {
        super.onStart()
        PetService.instance?.setShown(false)
    }

    override fun onStop() {
        PetService.instance?.setShown(true)
        super.onStop()
    }

    override fun onDestroy() {
        web.destroy()
        if (isFinishing) {
            val played = JSONObject()
                .put("minutes", (SystemClock.elapsedRealtime() - start) / 60000.0)
                .put("windowId", windowId)
                .toString()
            PetService.instance?.emit("gamePlayed", played)
        }
        super.onDestroy()
    }
}
