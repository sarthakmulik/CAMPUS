package com.campus.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * The bridge activity plus two notification-design duties:
 *  - foreground flag: CampusMessagingService skips posting while the app is
 *    on screen (the realtime bell already shows every event);
 *  - action cleanup: Like/Reply deep links carry the nid/tag of the
 *    notification they came from — clear it from the shade on arrival
 *    (the system autoCancel flag only covers body taps, not action buttons).
 */
public class MainActivity extends BridgeActivity {

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        dismissSourceNotification(getIntent());
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
