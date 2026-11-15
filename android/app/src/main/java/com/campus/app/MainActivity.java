package com.campus.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * The bridge activity plus three notification/inset duties:
 *  - foreground flag: CampusMessagingService skips posting while the app is
 *    on screen (the realtime bell already shows every event);
 *  - action cleanup: Like/Reply deep links carry the nid/tag of the
 *    notification they came from — clear it from the shade on arrival
 *    (the system autoCancel flag only covers body taps, not action buttons);
 *  - safe insets: the Android WebView can report env(safe-area-inset-*) as 0
 *    even with edge-to-edge + shortEdges (device-dependent), so the shell's
 *    header hides under the camera cutout. The REAL status-bar + cutout +
 *    navbar insets are measured here and handed to CSS two ways: a
 *    synchronous pull at boot (InsetsBridge via addJavascriptInterface, read
 *    by the inline script in index.html before first paint) and pushes on
 *    every later insets change (rotation, keyboard, foldables).
 */
public class MainActivity extends BridgeActivity {

    /** Latest measured insets (px). The web pulls them synchronously at boot
     *  and receives pushes on later changes; volatile so the JS thread reads
     *  what the layout thread wrote. */
    private static volatile int insetTop = 0, insetBottom = 0, insetLeft = 0, insetRight = 0;

    /** Synchronous pull for the boot script in index.html. Read-only ints —
     *  no sensitive surface is exposed to the webview. */
    public static class InsetsBridge {
        @JavascriptInterface
        public String get() {
            return insetTop + "," + insetBottom + "," + insetLeft + "," + insetRight;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bridge bridge = getBridge();
        if (bridge != null) {
            WebView web = bridge.getWebView();
            web.addJavascriptInterface(new InsetsBridge(), "CampusNativeInsets");
            // The listener returns the insets untouched — Capacitor's own
            // (SystemBars) handlers keep receiving them.
            ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (v, insets) -> {
                applyInsets(insets);
                return insets;
            });
        }
        dismissSourceNotification(getIntent());
    }

    private void applyInsets(WindowInsetsCompat insets) {
        // statusBars + navigationBars + displayCutout: per side this is the
        // max of the three — exactly the chrome-free zone the CSS reserves.
        // IME is deliberately excluded: the keyboard resizes the viewport
        // (interactive-widget=resizes-content) and must not pad the shell.
        Insets measured = insets.getInsets(
                WindowInsetsCompat.Type.statusBars()
                        | WindowInsetsCompat.Type.navigationBars()
                        | WindowInsetsCompat.Type.displayCutout());
        if (measured.top == insetTop && measured.bottom == insetBottom
                && measured.left == insetLeft && measured.right == insetRight) {
            return;
        }
        // physical px → CSS px: the WebView lays out in density-independent
        // pixels, but inset values arrive in physical device px. Injecting
        // them raw inflated every reserved space by the density factor
        // (~2.6 on a moto g72) — the giant white band above the header in
        // 1.0.4 was exactly this unit bug.
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) density = 1f;
        insetTop = Math.round(measured.top / density);
        insetBottom = Math.round(measured.bottom / density);
        insetLeft = Math.round(measured.left / density);
        insetRight = Math.round(measured.right / density);
        pushInsets();
    }

    private void pushInsets() {
        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView web = bridge.getWebView();
        if (web == null) return;
        final int top = insetTop, bottom = insetBottom, left = insetLeft, right = insetRight;
        web.post(() -> web.evaluateJavascript(
                "try{var d=document.documentElement;"
                        + "d.style.setProperty('--native-inset-top','" + top + "px');"
                        + "d.style.setProperty('--native-inset-bottom','" + bottom + "px');"
                        + "d.style.setProperty('--native-inset-left','" + left + "px');"
                        + "d.style.setProperty('--native-inset-right','" + right + "px');"
                        + "}catch(e){}",
                null));
    }

    @Override
    public void onResume() {
        super.onResume();
        CampusMessagingService.setAppVisible(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        CampusMessagingService.setAppVisible(false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        dismissSourceNotification(intent);
    }

    private void dismissSourceNotification(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return;
        String nid = data.getQueryParameter("nid");
        if (nid == null || nid.isEmpty()) return;
        String tag = data.getQueryParameter("tag");
        try {
            NotificationManagerCompat.from(this).cancel(
                    tag == null || tag.isEmpty() ? "campus" : tag, nid.hashCode());
        } catch (Exception ignored) {
        }
    }
}
