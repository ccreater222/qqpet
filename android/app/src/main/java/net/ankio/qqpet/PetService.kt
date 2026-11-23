package net.ankio.qqpet

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.Icon
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.WindowManager.LayoutParams
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/** Server mode device token: AES/GCM ciphertext only, never reachable through the page file API. */
private const val REMOTE_TOKEN_FILE = "remote-token.bin"
private const val REMOTE_TOKEN_KEY_ALIAS = "qqpet-remote-token-v1"
private const val REMOTE_TOKEN_KEYSTORE = "AndroidKeyStore"
private const val REMOTE_TOKEN_TRANSFORMATION = "AES/GCM/NoPadding"
private const val REMOTE_TOKEN_VERSION = 1

/**
 * Hosts the pet page in a cropped render window and shapes its touch area with portals.
 *
 * The WebView lives in a [TYPE_APPLICATION_ATTACHED_DIALOG] child of a 1x1 overlay window: the dialog type is not a
 * system alert window, so Android keeps its alpha at 1.0 while it is NOT_TOUCHABLE (a plain overlay with the same
 * flag is dimmed to 0.8 by DisplayPolicy). The child is cropped to the page's currently visible pixels plus a small
 * margin, because a NOT_TOUCHABLE window still occludes untrusted windows below it (BLOCK_UNTRUSTED touch occlusion);
 * the WebView is translated by the window origin so the page stays anchored to the display. The page reports those
 * pixels through [Bridge.setTouchableRegion]; one transparent overlay portal per merged rectangle forwards its
 * touches into the WebView and every other pixel reaches the app below. [setBounds] is kept as a no-op.
 */
class PetService : Service() {
    companion object {
        /** The running service, for GameActivity to report play time. */
        var instance: PetService? = null
            private set

        private const val NOTIFICATION_ID = 1
        private const val TRAY_ICON_PX = 96
        /** An empty visible-pixel report is kept this long before the render window collapses to 1x1. */
        private const val EMPTY_SHRINK_MS = 800L
        /** Width/height change above this (px) counts as a resize worth hiding the window for. */
        private const val BIG_RESIZE_PX = 200
        /** Uptime after which a still-hidden render window is forced visible (a lost reveal is worse than a flash). */
        private const val HIDDEN_WATCHDOG_MS = 300L
        /** How long the render window stays hidden across a big resize so the first visible frame has content. */
        private const val REVEAL_DELAY_MS = 100L
        /** Hard fallback beyond the reveal delay (e.g. a handler hiccup). */
        private const val REVEAL_TIMEOUT_MS = 300L
        /** Short hide for changes that only move the pet (drags); hiding it longer would be visible. */
        private const val REVEAL_SHORT_MS = 32L
    }

    private lateinit var wm: WindowManager
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private val net = Executors.newCachedThreadPool()
    private val prefs by lazy { getSharedPreferences("qqpet", MODE_PRIVATE) }

    /** The render window, added as the dialog child of [host] once the host has a window token. */
    private var rootParams: LayoutParams? = null

    /** Slack (px) kept around the page's visible rectangles in the render window. */
    private val childMargin = 6

    /**
     * The render window is cropped to the visible rectangles, not the whole display: a NOT_TOUCHABLE attached
     * dialog still uses BLOCK_UNTRUSTED touch occlusion, so a full-screen one would stop touches from reaching
     * untrusted windows below (the launcher) even where the page draws nothing. Null until the page reports.
     */
    private var childRect: Rect? = null

    /** The last crop was the 1x1 "nothing visible" window; the next content must not be unioned with it. */
    private var childWasEmpty = false

    /** When the page first reported no visible pixels; transient empty animation frames must not collapse the window. */
    private var emptySince = 0L

    /** Bumped on every hide so a late reveal from an older resize cannot show a half-drawn frame. */
    private var revealToken = 0

    /** Uptime of the last 1->0 hide; the watchdog force-shows the window if a reveal was lost. */
    private var hiddenAt = 0L

    /**
     * 1x1 transparent overlay that only exists to own a window token: the real render window is added as its
     * TYPE_APPLICATION_ATTACHED_DIALOG child, a type that is not a system-alert window and therefore keeps
     * alpha 1.0 when it is NOT_TOUCHABLE (DisplayPolicy caps system alert windows at 0.8).
     */
    private lateinit var host: View
    private val hostParams = LayoutParams(
        1, 1, LayoutParams.TYPE_APPLICATION_OVERLAY,
        LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCHABLE or LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 0
        y = 0
        title = "QQPet touch host"
    }

    /** True once the render window is attached (it may be delayed until [host] has a window token). */
    private var rootAdded = false

    /** The page has a bottom sheet open and expects the back key (see [Bridge.setBackHandler]). */
    @Volatile
    private var backHandler = false

    /** Set only while the page reports a running small game; gates all native arrow keys. */
    @Volatile
    private var gameKeyActive = false

    /** Trusted arrow keys currently injected into the small-game overlay (37/39). */
    private val gameKeyLock = Any()
    private val gameKeysDown = mutableSetOf<Int>()
    private val gameKeyLast = mutableMapOf<String, Long>()

    private lateinit var probe: View
    private val probeParams = LayoutParams(
        1, 1, LayoutParams.TYPE_APPLICATION_OVERLAY,
        LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCHABLE or LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }

    override fun onBind(intent: Intent?) = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate() {
        super.onCreate()
        instance = this
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("pet", "QQ宠物", NotificationManager.IMPORTANCE_LOW))
        startForeground(NOTIFICATION_ID, notification())
        wm = getSystemService(WindowManager::class.java)
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = AssetClient(this@PetService) { hd() }
            addJavascriptInterface(Bridge(), "QQPetNative")
        }
        root = object : FrameLayout(this) {
            override fun dispatchTouchEvent(e: MotionEvent): Boolean {
                if (e.actionMasked != MotionEvent.ACTION_OUTSIDE) return super.dispatchTouchEvent(e)
                emit("outside", "undefined")
                return true
            }

            // A focusable overlay takes the back key from the app below; give it back.
            override fun dispatchKeyEvent(e: KeyEvent): Boolean {
                if (e.keyCode != KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(e)
                // A phone sheet owns the key while it is up: the page closes it and releases the focus itself.
                if (backHandler) {
                    web.evaluateJavascript("window.__qqpetBack && window.__qqpetBack()", null)
                    return true
                }
                setFocusable(false)
                return true
            }
        }
        root.addView(web, screenSize())
        // A hidden window gets no insets, so a separate always-shown pixel watches the status bar.
        probe = View(this)
        probe.setOnApplyWindowInsetsListener { _, insets ->
            fullscreen = !insets.isVisible(WindowInsets.Type.statusBars())
            applyShown()
            insets
        }
        wm.addView(probe, probeParams)
        host = View(this).apply { setBackgroundColor(Color.TRANSPARENT) }
        wm.addView(host, hostParams)
        // The child window needs the host's window token, which only exists once it is attached.
        host.post { attachRenderWindow() }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screen, filter, RECEIVER_NOT_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(screen, filter)
    }

    private var gone = false

    private fun presence(on: Boolean) {
        if (on == gone) return
        gone = on
        emit("presence", if (on) "true" else "false")
    }

    private val screen = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_SCREEN_OFF -> presence(true)
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> presence(false)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "state", "menu", "show", "hide" -> emit("trayClick", JSONObject().put("kind", intent.action).toString())
            "quit" -> stopSelf()
        }
        return START_STICKY
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        web.layoutParams = screenSize()
        val p = rootParams ?: return
        val display = wm.maximumWindowMetrics.bounds
        // The old crop belongs to the old display; start full-size and let the next page report crop it again.
        hideChildForResize("rotation")
        childRect = null
        web.translationX = 0f
        web.translationY = 0f
        p.x = 0
        p.y = 0
        p.width = display.width()
        p.height = display.height()
        if (rootAdded) wm.updateViewLayout(root, p)
        web.invalidate()
        revealChildAfterResize(REVEAL_DELAY_MS)
    }

    override fun onDestroy() {
        instance = null
        unregisterReceiver(screen)
        clearPortals()
        if (rootAdded) wm.removeView(root)
        wm.removeView(probe)
        wm.removeView(host)
        web.destroy()
        net.shutdownNow()
        super.onDestroy()
    }

    /**
     * Attaches the WebView window as an attached dialog of [host]. The dialog type is not a system alert window, so
     * Android keeps alpha 1.0 while the window is NOT_TOUCHABLE (DisplayPolicy caps system alert windows at 0.8).
     * It starts at full display size and [applyChildBounds] crops it to the page's visible rectangles: the frame is
     * also the occlusion area of a BLOCK_UNTRUSTED window, so it must not cover pixels the page does not draw.
     * The WebView stays display-anchored through translation while the window moves under it.
     * A ROM that refuses dialog children falls back to the overlay type (still NOT_TOUCHABLE, but dimmed) and
     * says so in logcat instead of failing silently.
     */
    private fun attachRenderWindow() {
        val display = wm.maximumWindowMetrics.bounds
        val p = LayoutParams(
            1, 1, LayoutParams.TYPE_APPLICATION_ATTACHED_DIALOG,
            LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCHABLE or LayoutParams.FLAG_NOT_TOUCH_MODAL or
                LayoutParams.FLAG_LAYOUT_IN_SCREEN or LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
            token = host.windowToken
            fitInsetsTypes = 0
            layoutInDisplayCutoutMode = LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            alpha = 1f
            title = "QQPet render"
        }
        noMoveAnimation(p)
        web.translationX = 0f
        web.translationY = 0f
        try {
            wm.addView(root, p)
        } catch (e: Throwable) {
            Log.e("QQPet", "attached dialog render window unavailable; falling back to the overlay type", e)
            p.type = LayoutParams.TYPE_APPLICATION_OVERLAY
            p.token = null
            try {
                wm.addView(root, p)
            } catch (e2: Throwable) {
                Log.e("QQPet", "render window unavailable", e2)
                return
            }
        }
        rootParams = p
        rootAdded = true
        web.loadUrl("$ORIGIN/index.html")
    }

    private fun screenSize(): FrameLayout.LayoutParams {
        val b = wm.maximumWindowMetrics.bounds
        return FrameLayout.LayoutParams(b.width(), b.height())
    }

    private fun hd(): Boolean = try {
        JSONObject(File(filesDir, "save.json").readText()).getJSONObject("settings").optBoolean("hd")
    } catch (_: Exception) {
        // No save yet, or a corrupt one the page is about to replace.
        false
    }

    /** The tray state the page last set: its icon, or the app's own until then, and its tooltip. */
    private var trayIcon: Icon? = null
    private var trayTip = "点按查看宠物状态"

    private fun setTray(icon: String, tip: String?) {
        val path = "pet/img_res/Tray/$icon"
        val bitmap = try {
            assets.open(path.replace(".png", "@2x.png"))
        } catch (_: FileNotFoundException) {
            assets.open(path)
        }.use { BitmapFactory.decodeStream(it) }
        // Pixel art: scale without smoothing. The status bar draws it as a silhouette, the shade in colour.
        trayIcon = Icon.createWithBitmap(Bitmap.createScaledBitmap(bitmap, TRAY_ICON_PX, TRAY_ICON_PX, false))
        if (tip != null) trayTip = tip
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
    }

    /** The page hid the pet (菜单 隐藏宠物); the notification then offers to show it again. */
    private var petHidden = false

    private fun setHidden(on: Boolean) {
        if (on == petHidden) return
        petHidden = on
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
    }

    private fun notification(): Notification {
        // Through TrayActivity, which closes the shade; quitting needs no shade closed.
        fun tap(name: String) = PendingIntent.getActivity(
            this, name.hashCode(),
            Intent(this, TrayActivity::class.java).setAction(name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun action(name: String) = PendingIntent.getService(this, name.hashCode(), Intent(this, PetService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "pet")
            .setSmallIcon(trayIcon ?: Icon.createWithResource(this, R.drawable.ic_notification))
            .setLargeIcon(trayIcon)
            .setContentTitle("QQ宠物")
            .setContentText(if (petHidden) "宠物隐藏中，点按显示" else trayTip)
            // A hidden pet has nothing to tap: the notification is the way back.
            .setContentIntent(tap(if (petHidden) "show" else "state"))
            .addAction(Notification.Action.Builder(null, if (petHidden) "显示宠物" else "隐藏宠物", tap(if (petHidden) "show" else "hide")).build())
            .addAction(Notification.Action.Builder(null, "菜单", tap("menu")).build())
            .addAction(Notification.Action.Builder(null, "退出", action("quit")).build())
            .setOngoing(true)
            .build()
    }

    /** Calls `__qqpet.emit(type, payload)`; [payload] is a JS expression. */
    fun emit(type: String, payload: String) = web.post { web.evaluateJavascript("__qqpet.emit('$type', $payload)", null) }

    private fun resolve(id: Int, value: String?, error: String? = null) = web.post {
        web.evaluateJavascript("__qqpet.resolve($id, ${quote(value)}, ${quote(error)})", null)
    }

    private fun quote(s: String?) = if (s == null) "null" else JSONObject.quote(s)

    /** Drops every held arrow key before the overlay gives up small-game focus or visibility. */
    private fun releaseGameKeys() {
        val codes = synchronized(gameKeyLock) {
            val held = gameKeysDown.toList()
            gameKeysDown.clear()
            gameKeyLast.clear()
            held
        }
        if (codes.isEmpty()) return
        web.post {
            for (code in codes) {
                try { web.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code)) } catch (_e: Throwable) { /* view may be gone */ }
            }
        }
    }

    private fun setFocusable(on: Boolean) {
        if (!on) releaseGameKeys()
        val p = rootParams ?: return
        p.flags = if (on) p.flags and LayoutParams.FLAG_NOT_FOCUSABLE.inv() else p.flags or LayoutParams.FLAG_NOT_FOCUSABLE
        if (rootAdded) wm.updateViewLayout(root, p)
    }

    /**
     * The render window is cropped from the touch portal rectangles instead of this legacy contract: the page reports
     * its visible pixels through [Bridge.setTouchableRegion], and the window only has to cover them. The method stays
     * because the page still calls it (and older pages expect it).
     */
    @Suppress("UNUSED_PARAMETER")
    private fun setBounds(x: Double, y: Double, w: Double, h: Double, viewport: Double) {
        // No-op by design: portals own the touch area and the visible-pixel union owns the render crop.
    }

    private fun http(id: Int, method: String, url: String, headers: String, body: String?) = net.execute {
        try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 60_000
            c.readTimeout = 60_000
            val h = JSONObject(headers)
            for (k in h.keys()) c.setRequestProperty(k, h.getString(k))
            if (body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val text = (if (c.responseCode < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            resolve(id, JSONObject().put("status", c.responseCode).put("body", text).toString())
        } catch (e: Exception) {
            // Runs on a pool thread: anything uncaught here kills the app.
            resolve(id, null, e.toString())
        }
    }

    /** One transparent overlay window per page-reported visible rectangle; it forwards its touches into [web]. */
    private class Portal(val view: View, var params: LayoutParams)

    /** Page rectangles in CSS px and the innerWidth they were measured at; null until the first report. */
    private var touchRects: List<RectF>? = null
    private var touchViewport = 0.0

    /** Portals with a forwarded gesture in flight: moving or removing one would cut its touch stream. */
    private val touchActive = mutableSetOf<View>()
    private var touchDeferred = false

    /**
     * Portals are unavailable on this build. The service stays fail-closed: the render window is NOT made touchable
     * again, because a touchable window would swallow every touch meant for the apps below (the pet is unreachable
     * until restart, which logcat makes visible). Portal problems must never escalate like that.
     */
    private var touchPortalsFailed = false

    private val portals = mutableListOf<Portal>()

    /**
     * Places the touch portals from the page's currently visible pixels. The render window is NOT_TOUCHABLE from
     * the moment it is attached, so every touch inside these rectangles is forwarded into [web] and everything else
     * reaches the app below; the render window itself is cropped to the union of these rectangles. The page reports
     * {@code rects} as a JSON array
     * of {x,y,width,height} in CSS pixels of a [viewport]-wide page; an empty or unreadable array removes every
     * portal (the pet becomes untouchable, as when it is hidden). Public APIs only: the hidden internal-insets
     * touchable-region API is filtered by the hidden-API policy. {@code setBounds} is a no-op for this window.
     */
    private fun setTouchableRegion(rects: String, viewport: Double) {
        val parsed = try {
            val array = JSONArray(rects)
            (0 until array.length()).map { i ->
                val r = array.getJSONObject(i)
                val x = r.getDouble("x")
                val y = r.getDouble("y")
                RectF(x.toFloat(), y.toFloat(), (x + r.getDouble("width")).toFloat(), (y + r.getDouble("height")).toFloat())
            }
        } catch (e: Exception) {
            Log.w("QQPet", "setTouchableRegion: unreadable rects, window left untouchable", e)
            emptyList()
        }
        touchRects = parsed
        touchViewport = if (viewport.isFinite() && viewport > 0.0) viewport else 0.0
        if (touchPortalsFailed) return
        if (touchViewport == 0.0) Log.w("QQPet", "setTouchableRegion: bad viewport $viewport, no touchable area")
        syncPortals()
    }

    /**
     * Makes the portal windows match the last reported rectangles. The WebView covers the whole display at (0,0), so
     * page px * scale is already the display position a touch lands at. Portals are reused by index: an animation
     * that nudges the pet only updates its portal bounds, no window churn.
     */
    private fun syncPortals() {
        try {
            syncPortalsUnchecked()
        } catch (e: Throwable) {
            // A touchable render window would block the apps below, so the pet gives up touch instead:
            // clear the portals and make the failure visible in logcat.
            Log.e("QQPet", "touch portals unavailable; the pet stays untouchable", e)
            clearPortals()
            touchPortalsFailed = true
        }
    }

    private fun syncPortalsUnchecked() {
        val rects = touchRects ?: return
        if (root.visibility != View.VISIBLE) return
        val scale = if (touchViewport > 0.0) web.layoutParams.width / touchViewport else 0.0
        if (scale <= 0.0) {
            Log.w("QQPet", "setTouchableRegion: bad viewport $touchViewport, no touchable area")
            clearPortals()
            return
        }
        val display = wm.maximumWindowMetrics.bounds
        val wanted = rects.mapNotNull { r ->
            val box = Rect(
                floor(r.left.toDouble() * scale).toInt(),
                floor(r.top.toDouble() * scale).toInt(),
                ceil(r.right.toDouble() * scale).toInt(),
                ceil(r.bottom.toDouble() * scale).toInt(),
            )
            // Clipping is a safety net only: the page reports inside its own viewport.
            if (box.intersect(0, 0, display.width(), display.height())) box else null
        }.filter { it.width() > 0 && it.height() > 0 }
        val boxes = mergeRects(wanted)
        // The render window is NOT_TOUCHABLE, so it may follow the page during a gesture without cutting the touch
        // stream; otherwise a dragged pet leaves its old crop and disappears until ACTION_UP.
        applyChildBounds(boxes)
        if (touchActive.isNotEmpty()) {
            // Portals stay put until ACTION_UP/CANCEL: moving the touch windows under the finger would drop it.
            touchDeferred = true
            return
        }
        while (portals.size > boxes.size) removePortal(portals.removeAt(portals.size - 1))
        for (i in boxes.indices) {
            val portal = portals.getOrNull(i)
            if (portal == null) portals.add(addPortal(boxes[i])) else movePortal(portal, boxes[i])
        }
        // Hidden by away/fullscreen earlier; the pet is shown again.
        for (portal in portals) if (portal.view.visibility != View.VISIBLE) portal.view.visibility = View.VISIBLE
    }

    /**
     * Drops rectangles contained in another and unions intersecting ones: the page reports a [data-hit] root plus
     * its children, so one panel can arrive as dozens of nested rectangles. Usually one to three boxes remain.
     */
    private fun mergeRects(rects: List<Rect>): List<Rect> {
        val out = mutableListOf<Rect>()
        for (r in rects) {
            val box = Rect(r)
            var i = 0
            while (i < out.size) {
                if (Rect.intersects(box, out[i])) {
                    box.union(out[i])
                    out.removeAt(i)
                    i = 0
                } else i++
            }
            out.add(box)
        }
        return out
    }

    /**
     * Crops the render window to the union of [boxes] plus [childMargin], keeping the WebView anchored to the
     * display by translating it by the window origin (the page must not slide when the window moves). The window
     * only grows/shrinks when the union leaves the current frame or leaves more than two margins of slack, so
     * small animation nudges do not churn it. A transient empty report (an animation frame with nothing drawn) keeps
     * the window; only an empty report that persists for [EMPTY_SHRINK_MS] collapses it to 1x1, where the page draws
     * nothing and must occlude nothing.
     */
    private fun applyChildBounds(boxes: List<Rect>) {
        val p = rootParams ?: return
        val displayBounds = wm.maximumWindowMetrics.bounds
        val display = Rect(0, 0, displayBounds.width(), displayBounds.height())
        if (boxes.isEmpty()) {
            val now = SystemClock.uptimeMillis()
            if (emptySince == 0L) {
                emptySince = now
                root.postDelayed({
                    if (emptySince != 0L && touchRects?.isEmpty() == true) applyChildBounds(emptyList())
                }, EMPTY_SHRINK_MS)
                return
            }
            if (now - emptySince < EMPTY_SHRINK_MS) return
        } else {
            emptySince = 0L
        }
        val union = if (boxes.isEmpty()) Rect(0, 0, 1, 1) else {
            val u = Rect(boxes.first())
            for (b in boxes.drop(1)) u.union(b)
            u.inset(-childMargin, -childMargin)
            u.intersect(display)
            u
        }
        val current = childRect
        if (boxes.isNotEmpty() && current != null) {
            if (current == union) return
            if (current.contains(union)) {
                val slack = maxOf(union.left - current.left, union.top - current.top, current.right - union.right, current.bottom - union.bottom)
                // Keep the window while it only carries a thin ring around the content; this damps window churn.
                if (slack <= childMargin * 2) return
            }
        }
        val next = Rect(union)
        if (boxes.isNotEmpty() && current != null && !childWasEmpty && !current.contains(union)) {
            // Content left the frame: cover both. Moving the frame only changes clipping (the page stays anchored).
            next.union(current)
            next.intersect(display)
        }
        // A surface resize can show a white/background-only buffer for a frame. Only a real SIZE change hides the
        // window: the pet animation moves the frame every tick, and hiding on position changes kept it invisible.
        val big = current == null || bigResize(current, next)
        val expanding = current == null || next.width() * next.height() > current.width() * current.height() * 1.3f
        if (big) hideChildForResize(if (expanding) "expand" else "shrink")
        childWasEmpty = boxes.isEmpty()
        childRect = next
        web.translationX = -next.left.toFloat()
        web.translationY = -next.top.toFloat()
        p.x = next.left
        p.y = next.top
        p.width = next.width()
        p.height = next.height()
        if (rootAdded) wm.updateViewLayout(root, p)
        // Chromium rasters only the visible rect; without this, content uncovered by a bigger window stays blank.
        web.invalidate()
        // A sheet opening draws a large flat background: the first committed frame can still be that background
        // without content, so wait long enough. A drag only draws the pet, and hiding it would be visible, so keep
        // that path short.
        if (big) revealChildAfterResize(if (expanding && touchActive.isEmpty()) REVEAL_DELAY_MS else REVEAL_SHORT_MS)
    }

    /** True when the window change is large enough to hide across (size only; position moves are free). */
    private fun bigResize(current: Rect, next: Rect): Boolean {
        val dw = abs(next.width() - current.width())
        val dh = abs(next.height() - current.height())
        if (dw > BIG_RESIZE_PX || dh > BIG_RESIZE_PX) return true
        if (dw * 4 > current.width() || dh * 4 > current.height()) return true
        val area = current.width().toLong() * current.height()
        val nextArea = next.width().toLong() * next.height()
        if (area <= 0L) return true
        return nextArea > area * 2 || area > nextArea * 2
    }

    /**
     * Hides the whole render window while its surface changes size. Hiding only the WebView is not enough: the
     * white background of the child window's own surface is what shows when the window grows/shrinks before
     * Chromium has drawn the new size. A second call while already hidden keeps the pending reveal (it must not
     * cancel it, or an animated pet would keep the window hidden forever).
     */
    private fun hideChildForResize(reason: String) {
        val p = rootParams ?: return
        if (p.alpha == 0f) return
        revealToken++
        hiddenAt = SystemClock.uptimeMillis()
        p.alpha = 0f
        if (rootAdded) wm.updateViewLayout(root, p)
        Log.i("QQPet", "child hidden for $reason")
        web.postDelayed({
            if (rootParams?.alpha == 0f) {
                Log.w("QQPet", "child stayed hidden ${SystemClock.uptimeMillis() - hiddenAt}ms; forcing it visible")
                showChildNow()
            }
        }, HIDDEN_WATCHDOG_MS)
    }

    /** Forces the render window visible; also drops any pending reveal from an older resize. */
    private fun showChildNow() {
        revealToken++
        hiddenAt = 0L
        val p = rootParams ?: return
        if (p.alpha != 1f) {
            p.alpha = 1f
            if (rootAdded) wm.updateViewLayout(root, p)
            web.invalidate()
        }
    }

    /**
     * Shows the render window again only after the WebView has had time to raster the new size. The first committed
     * frame after a resize can still be the white surface or the sheet's flat background without content, so the
     * window stays hidden for [delayMs] (100 ms for a sheet expansion, 32 ms when only the pet moves) and
     * [revealToken] drops stale reveals from an older resize. A second, later call is the safety net.
     */
    private fun revealChildAfterResize(delayMs: Long) {
        val token = revealToken
        fun reveal() {
            if (token != revealToken) return
            showChildNow()
        }
        web.invalidate()
        // The first committed frame(s) after a resize can still be the background-only sheet (a large blank
        // rectangle). Wait long enough for the renderer to raster the content, then show the window.
        web.postDelayed({ reveal() }, delayMs)
        web.postDelayed({ reveal() }, delayMs + REVEAL_TIMEOUT_MS)
    }

    private fun addPortal(box: Rect): Portal {
        val view = object : View(this) {
            override fun onTouchEvent(e: MotionEvent): Boolean {
                forwardTouch(this, e)
                return true
            }
        }.apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        val portalParams = LayoutParams(box.width(), box.height(), LayoutParams.TYPE_APPLICATION_OVERLAY, portalFlags(), PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.START
            x = box.left
            y = box.top
            layoutInDisplayCutoutMode = LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            fitInsetsTypes = 0
            title = "QQPet touch portal"
        }
        noMoveAnimation(portalParams)
        wm.addView(view, portalParams)
        return Portal(view, portalParams)
    }

    /** The portal only forwards touches; the pet window keeps focus, IME and key handling. */
    private fun portalFlags(): Int = LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCH_MODAL or
        LayoutParams.FLAG_LAYOUT_IN_SCREEN or LayoutParams.FLAG_LAYOUT_NO_LIMITS

    /** PRIVATE_FLAG_NO_MOVE_ANIMATION, so a portal jumps with the pet instead of sliding (hidden API, best effort). */
    private fun noMoveAnimation(p: LayoutParams) {
        try {
            val f = LayoutParams::class.java.getField("privateFlags")
            f.setInt(p, f.getInt(p) or 0x40)
        } catch (e: Throwable) {
            Log.w("QQPet", "no-move-animation flag unavailable", e)
        }
    }

    private fun movePortal(portal: Portal, box: Rect) {
        val p = portal.params
        if (p.x == box.left && p.y == box.top && p.width == box.width() && p.height == box.height()) return
        p.x = box.left
        p.y = box.top
        p.width = box.width()
        p.height = box.height()
        wm.updateViewLayout(portal.view, p)
    }

    private fun removePortal(portal: Portal) {
        touchActive.remove(portal.view)
        try {
            wm.removeView(portal.view)
        } catch (e: Exception) {
            Log.w("QQPet", "touch portal removal failed", e)
        }
    }

    private fun clearPortals() {
        touchActive.clear()
        touchDeferred = false
        for (portal in portals) removePortal(portal)
        portals.clear()
    }

    /**
     * Forwards one touch stream into the WebView, shifted from the portal's screen origin to the WebView's (which
     * covers the display, so a screen point is the WebView-local point). The stream must end before portals move:
     * see [touchDeferred].
     */
    private fun forwardTouch(view: View, e: MotionEvent) {
        if (e.actionMasked == MotionEvent.ACTION_DOWN) touchActive.add(view)
        try {
            val from = IntArray(2)
            view.getLocationOnScreen(from)
            val to = IntArray(2)
            web.getLocationOnScreen(to)
            // Event coordinates are portal-local; moving them by (portal origin - WebView origin) makes them
            // WebView-local (the WebView covers the display, so this is screen-first).
            val copy = MotionEvent.obtain(e)
            copy.offsetLocation((from[0] - to[0]).toFloat(), (from[1] - to[1]).toFloat())
            try {
                web.dispatchTouchEvent(copy)
            } finally {
                copy.recycle()
            }
        } catch (e: Throwable) {
            Log.w("QQPet", "touch portal forwarding failed", e)
        }
        if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) {
            touchActive.remove(view)
            if (touchActive.isEmpty() && touchDeferred) {
                touchDeferred = false
                syncPortals()
            }
        }
    }

    /** One of ours (a file picker, a game) is in front. */
    private var away = false

    /** The app in front hides the status bar. */
    private var fullscreen = false

    /** The overlay stays above every app; it steps aside while [away] or [fullscreen]. */
    private fun applyShown() {
        root.visibility = if (away || fullscreen) View.GONE else View.VISIBLE
        // A game or app in front must not get its touches forwarded into a hidden page.
        if (away || fullscreen) {
            clearPortals()
        } else {
            syncPortals()
            if (rootParams?.alpha == 0f) showChildNow()
        }
    }

    fun setShown(on: Boolean) = web.post {
        away = !on
        if (away) releaseGameKeys()
        applyShown()
    }

    private fun pickFile(intent: Intent, done: (Uri?) -> Unit) {
        setShown(false)
        FileActivity.done = { uri ->
            setShown(true)
            done(uri)
        }
        startActivity(Intent(this, FileActivity::class.java).putExtra(Intent.EXTRA_INTENT, intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** window.QQPetNative; see the Native interface in src/android/bridge.ts. Called on a WebView thread. */
    private inner class Bridge {
        @JavascriptInterface
        fun rotatableScreen(): Boolean {
            val portrait = packageManager.hasSystemFeature(PackageManager.FEATURE_SCREEN_PORTRAIT)
            val landscape = packageManager.hasSystemFeature(PackageManager.FEATURE_SCREEN_LANDSCAPE)
            // Android's compatibility rule also allows both when neither feature is declared.
            return portrait == landscape
        }

        @JavascriptInterface
        fun read(name: String): String? = File(filesDir, name).takeIf { it.exists() }?.readText()

        @JavascriptInterface
        fun write(name: String, text: String) {
            val tmp = File(filesDir, "$name.tmp")
            tmp.writeText(text)
            tmp.renameTo(File(filesDir, name))
        }

        /**
         * Exact state writes only; save.json and arbitrary app-private paths are rejected.
         * The server-mode files are page-owned, secret-free state; remote-token.bin is
         * deliberately absent so the page can only reach it through the Keystore methods.
         */
        private fun allowedStateName(name: String): Boolean {
            if (name == "save.v2.json" || name == "save.v2.json.bak" || name == "save.json.bak") return true
            if (name == "storage-config.json" || name == "sync-config.json" || name == "remote-projection-cache.json") return true
            val prefix = "save.v2.json.corrupt-"
            if (name.startsWith(prefix) == false) return false
            val suffix = name.substring(prefix.length)
            return suffix.isNotEmpty() && suffix.all { it in '0'..'9' }
        }

        private fun stateFile(name: String): File? =
            if (allowedStateName(name)) File(filesDir, name) else null

        private fun okRead(text: String?): String =
            JSONObject().put("status", "ok").put("text", text ?: JSONObject.NULL).toString()

        private fun errorRead(message: String): String =
            JSONObject().put("status", "error").put("error", message).toString()

        private fun readFileResult(file: File): String {
            if (file.exists() == false) return okRead(null)
            if (file.isFile == false) return errorRead("State path is not a regular file")
            return try {
                okRead(file.readText())
            } catch (e: Exception) {
                errorRead(e.message ?: e.toString())
            }
        }

        /** Missing is ok+null; read failures are error results that the host must not migrate over. */
        @JavascriptInterface
        fun readStateFile(name: String): String {
            val file = stateFile(name) ?: return errorRead("Invalid local state filename")
            return readFileResult(file)
        }

        /** save.json is intentionally outside the state allowlist; only this read-only legacy bridge may read it. */
        @JavascriptInterface
        fun readLegacySave(): String = readFileResult(File(filesDir, "save.json"))

        /** Replace a complete C5b state file with fsync+ATOMIC_MOVE; false means fail closed. */
        @JavascriptInterface
        fun writeAtomic(name: String, text: String): Boolean {
            val target = stateFile(name) ?: return false
            return writeBytesAtomic(target, text.toByteArray(Charsets.UTF_8))
        }

        /**
         * Removes one allowlisted state file. The page can already replace these files through
         * writeAtomic, so removal grants no new authority; a missing file is success.
         */
        @JavascriptInterface
        fun removeStateFile(name: String): Boolean {
            val target = stateFile(name) ?: return false
            if (target.exists() == false) return true
            return try {
                target.delete()
            } catch (_e: Exception) {
                false
            }
        }

        /** fsync the whole payload, then swap it in with ATOMIC_MOVE; false means fail closed. */
        private fun writeBytesAtomic(target: File, bytes: ByteArray): Boolean {
            val tmp = File(filesDir, "." + target.name + "." + System.nanoTime() + ".tmp")
            return try {
                FileOutputStream(tmp).use { output ->
                    output.write(bytes)
                    output.fd.sync()
                }
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
                true
            } catch (_e: Exception) {
                tmp.delete()
                false
            }
        }

        /** remote-token.bin is not in the state allowlist: only these three methods touch it. */
        private fun tokenFile(): File = File(filesDir, REMOTE_TOKEN_FILE)

        /** Loads the app's AES key, creating it on first use; the key material never leaves the Keystore. */
        private fun tokenKey(): SecretKey {
            val store = KeyStore.getInstance(REMOTE_TOKEN_KEYSTORE).apply { load(null) }
            val existing = store.getEntry(REMOTE_TOKEN_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
            if (existing != null) return existing.secretKey
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, REMOTE_TOKEN_KEYSTORE)
            generator.init(
                KeyGenParameterSpec.Builder(
                    REMOTE_TOKEN_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            return generator.generateKey()
        }

        /**
         * Encrypts the device token with AES/GCM and writes it atomically. The file layout is
         * version(1) | ivLength(1) | iv | ciphertext, Base64 encoded. False means fail closed:
         * no plaintext fallback exists.
         */
        @JavascriptInterface
        fun saveRemoteToken(token: String): Boolean {
            if (token.isEmpty()) return false
            return try {
                val cipher = Cipher.getInstance(REMOTE_TOKEN_TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, tokenKey())
                val iv = cipher.iv
                val sealed = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
                val payload = ByteArray(2 + iv.size + sealed.size)
                payload[0] = REMOTE_TOKEN_VERSION.toByte()
                payload[1] = iv.size.toByte()
                System.arraycopy(iv, 0, payload, 2, iv.size)
                System.arraycopy(sealed, 0, payload, 2 + iv.size, sealed.size)
                writeBytesAtomic(tokenFile(), Base64.encodeToString(payload, Base64.NO_WRAP).toByteArray(Charsets.UTF_8))
            } catch (_e: Exception) {
                false
            }
        }

        /** Missing is ok+null; a decryption failure is an error the page must not overwrite blindly. */
        @JavascriptInterface
        fun loadRemoteToken(): String {
            val file = tokenFile()
            if (file.exists() == false) return okRead(null)
            if (file.isFile == false) return errorRead("Remote token path is not a regular file")
            return try {
                val payload = Base64.decode(file.readText(), Base64.DEFAULT)
                if (payload.size < 3 || payload[0].toInt() != REMOTE_TOKEN_VERSION) {
                    return errorRead("Remote token payload is invalid")
                }
                val ivSize = payload[1].toInt()
                if (ivSize <= 0 || payload.size <= 2 + ivSize) return errorRead("Remote token payload is truncated")
                val cipher = Cipher.getInstance(REMOTE_TOKEN_TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, tokenKey(), GCMParameterSpec(128, payload.copyOfRange(2, 2 + ivSize)))
                okRead(String(cipher.doFinal(payload.copyOfRange(2 + ivSize, payload.size)), Charsets.UTF_8))
            } catch (_e: Exception) {
                errorRead("Remote token could not be decrypted")
            }
        }

        /** Drops the ciphertext and the Keystore key; true once the token file is gone. */
        @JavascriptInterface
        fun clearRemoteToken(): Boolean {
            val file = tokenFile()
            if (file.exists() && file.delete() == false) return false
            try {
                KeyStore.getInstance(REMOTE_TOKEN_KEYSTORE).apply { load(null) }.deleteEntry(REMOTE_TOKEN_KEY_ALIAS)
            } catch (_e: Exception) {
                // The token is already gone; a leftover key encrypts nothing.
            }
            return true
        }

        @JavascriptInterface
        fun http(id: Int, method: String, url: String, headers: String, body: String?) = this@PetService.http(id, method, url, headers, body)

        @JavascriptInterface
        fun exportSave(id: Int, name: String, text: String) {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, name)
            pickFile(intent) { uri ->
                try {
                    if (uri != null) contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray()) }
                    resolve(id, uri?.let { "true" })
                } catch (e: Exception) {
                    resolve(id, null, e.toString())
                }
            }
        }

        @JavascriptInterface
        fun importSave(id: Int) {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            pickFile(intent) { uri ->
                try {
                    resolve(id, uri?.let { u -> contentResolver.openInputStream(u)!!.bufferedReader().use { it.readText() } })
                } catch (e: Exception) {
                    resolve(id, null, e.toString())
                }
            }
        }

        @JavascriptInterface
        fun openGame(swf: String, windowId: Int) = startActivity(Intent(this@PetService, GameActivity::class.java).putExtra("swf", swf).putExtra("windowId", windowId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

        @JavascriptInterface
        fun quit() = stopSelf()

        @JavascriptInterface
        fun copyText(text: String) = getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("QQ宠物", text))

        @JavascriptInterface
        fun openUrl(url: String) = startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

        @JavascriptInterface
        fun setFocusable(on: Boolean) = web.post { this@PetService.setFocusable(on) }

        /**
         * Small-game arrow key bridge: only 37/39, only while the page has the game overlay
         * focusable, 50 ms per (code, phase), down is not repeated until up, up is idempotent.
         * The actual KeyEvent is injected on the UI thread through WebView.dispatchKeyEvent.
         */
        @JavascriptInterface
        fun sendGameKey(code: String, phase: String): Boolean {
            if (!gameKeyActive) return false
            val keyCode = when (code) {
                "ArrowLeft" -> KeyEvent.KEYCODE_DPAD_LEFT
                "ArrowRight" -> KeyEvent.KEYCODE_DPAD_RIGHT
                else -> return false
            }
            val action = when (phase) {
                "down" -> KeyEvent.ACTION_DOWN
                "up" -> KeyEvent.ACTION_UP
                else -> return false
            }
            val now = SystemClock.uptimeMillis()
            synchronized(gameKeyLock) {
                val key = "$code:$phase"
                val last = gameKeyLast[key] ?: 0L
                if (now - last < 50L) return true
                gameKeyLast[key] = now
                if (action == KeyEvent.ACTION_DOWN) {
                    if (!gameKeysDown.add(keyCode)) return true
                } else if (!gameKeysDown.remove(keyCode)) {
                    return true
                }
            }
            web.post {
                try {
                    if (((rootParams?.flags ?: 0) and LayoutParams.FLAG_NOT_FOCUSABLE) != 0) setFocusable(true)
                    web.isFocusable = true
                    root.requestFocus()
                    web.requestFocus()
                    web.dispatchKeyEvent(KeyEvent(action, keyCode))
                } catch (e: Throwable) {
                    Log.w("QQPet", "small-game key injection failed", e)
                }
            }
            return true
        }

        /** Enables the arrow bridge only for the running small game; disabling releases held keys. */
        @JavascriptInterface
        fun setGameKeyActive(on: Boolean) {
            gameKeyActive = on
            if (!on) releaseGameKeys()
        }

        /** The page shows a bottom sheet that closes on the back key; kept in step with its focus. */
        @JavascriptInterface
        fun setBackHandler(on: Boolean) {
            backHandler = on
        }

        @JavascriptInterface
        fun setAutoStart(on: Boolean) = prefs.edit().putBoolean("autoStart", on).apply()

        @JavascriptInterface
        fun setTray(icon: String, tip: String?) = web.post { this@PetService.setTray(icon, tip) }

        @JavascriptInterface
        fun setHidden(on: Boolean) = web.post { this@PetService.setHidden(on) }

        @JavascriptInterface
        fun setBounds(x: Double, y: Double, w: Double, h: Double, viewport: Double) = web.post { this@PetService.setBounds(x, y, w, h, viewport) }

        /**
         * Optional contract: the page's current visible pixels in CSS px ({x,y,width,height} JSON array) and its
         * innerWidth. Older shells lack it, so the page only uses it when present (src/android/bridge.ts).
         */
        @JavascriptInterface
        fun setTouchableRegion(rects: String, viewport: Double) = web.post { this@PetService.setTouchableRegion(rects, viewport) }

        /** "left,top,right,bottom" of the system bars and cutout, in CSS pixels of a page [viewport] pixels wide. Hidden bars count: a swipe brings them back. */
        @JavascriptInterface
        fun safeArea(viewport: Double): String {
            val m = wm.maximumWindowMetrics
            val i = m.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val scale = m.bounds.width() / viewport
            return listOf(i.left, i.top, i.right, i.bottom).joinToString(",") { "${it / scale}" }
        }
    }
}
