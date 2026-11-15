package com.campus.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;

/**
 * Inline chat reply from the notification shade. Manifest-registered, so it
 * runs even when the CAMPUS process was dead. It clears the notification and
 * hands the typed text to the app through the same campus:// deep link the
 * notification system already routes — the webview then sends the message
 * under the user's own Supabase session, so credentials never leave the app
 * layer.
 */
public class ReplyReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        String nid = intent.getStringExtra("nid");
        String tag = intent.getStringExtra("tag");
        if (nid != null && !nid.isEmpty()) {
            try {
                manager.cancel(tag == null || tag.isEmpty() ? "campus" : tag, nid.hashCode());
            } catch (SecurityException ignored) {
            }
        }

        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence text = results == null
                ? null
                : results.getCharSequence(CampusMessagingService.KEY_REPLY_TEXT);
        String chat = intent.getStringExtra("chat");
        if (text == null || text.toString().trim().isEmpty()
                || chat == null || !chat.matches("(?i)[0-9a-f-]{32,36}")) {
            return;
        }

        Uri uri = new Uri.Builder()
                .scheme("campus")
                .authority("chat")
                .appendPath(chat)
                .appendQueryParameter("send", text.toString())
                .build();
        Intent open = new Intent(Intent.ACTION_VIEW, uri);
        open.setPackage(context.getPackageName());
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(open);
        } catch (Exception ignored) {
            // app cannot launch right now; the user can reply from the chat
        }
    }
}
