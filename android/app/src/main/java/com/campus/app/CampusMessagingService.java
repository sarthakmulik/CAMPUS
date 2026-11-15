package com.campus.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * CAMPUS' own FCM receiver — subclasses the Capacitor push plugin's service
 * so token rotation still reaches the JS registration listener untouched.
 *
 * Why this exists: system-rendered FCM notification messages cannot carry
 * action buttons (Like / Reply), cannot use a monochrome small icon (the
 * colored launcher "C" renders as a blank square), and cannot be styled.
 * The server therefore sends Android DATA-ONLY messages, and this service
 * builds the real notification:
 *   - monochrome C small icon + brand accent color (#6654f5)
 *   - BigTextStyle for long bodies, real event timestamp from the payload
 *   - two channels: campus_messages (chats) / campus_default (the rest)
 *   - Instagram-style actions: [Like] [Reply] on comment notifications,
 *     inline [Reply] (RemoteInput) on chat messages — every tap is a
 *     campus:// deep link the app already routes (with RLS, like the web).
 *
 * Foreground pushes are intentionally NOT posted here (appVisible): the
 * in-app realtime bell already covers every event while the app is open.
 */
public class CampusMessagingService extends MessagingService {

    /** RemoteInput key for the inline chat reply. */
    public static final String KEY_REPLY_TEXT = "campus_reply_text";
    /** Brand accent (--brand in styles.tokens.css): icon tint + action text. */
    private static final String BRAND_COLOR = "#6654f5";
    private static final String CHANNEL_DEFAULT = "campus_default";
    private static final String CHANNEL_MESSAGES = "campus_messages";

    private static volatile boolean appVisible = false;

    /** Set from MainActivity's onResume/onPause — the app shell shows every
     *  notification event in its realtime bell, so the shade stays quiet
     *  while the app is on screen. */
    public static void setAppVisible(boolean visible) {
        appVisible = visible;
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage); // plugin event plumbing
        Map<String, String> data = remoteMessage.getData();
        if (data.isEmpty() || appVisible) return;
        postNotification(data);
    }

    private void postNotification(Map<String, String> data) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if (!manager.areNotificationsEnabled()) return;
        ensureChannels();

        String category = orEmpty(data.get("category"));
        boolean isChat = "message".equals(category);
        String title = orEmpty(data.get("title"));
        if (title.isEmpty()) title = "CAMPUS";
        String body = orEmpty(data.get("body"));

        String tag = orEmpty(data.get("tag"));
        if (tag.isEmpty()) tag = "campus";
        String nid = orEmpty(data.get("nid"));
        int id = nid.isEmpty() ? tag.hashCode() : nid.hashCode();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(
                this, isChat ? CHANNEL_MESSAGES : CHANNEL_DEFAULT)
                .setSmallIcon(R.drawable.ic_stat_campus)
                .setColor(Color.parseColor(BRAND_COLOR))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setCategory(isChat
                        ? NotificationCompat.CATEGORY_MESSAGE
                        : NotificationCompat.CATEGORY_SOCIAL)
                .setWhen(parseWhen(data.get("created_at")));

        String link = orEmpty(data.get("link"));
        if (!link.isEmpty()) {
            builder.setContentIntent(viewPendingIntent(link, id));
        } else {
            builder.setContentIntent(PendingIntent.getActivity(
                    this, id, new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }

        // Actions exist only where they act on a real target: comment
        // notifications act on their comment; chat messages reply inline.
        // Everything else is a body tap to the payload's campus:// link.
        String postId = data.get("post_id");
        String commentId = data.get("comment_id");
        if ("comment".equals(category) && isUuid(postId) && isUuid(commentId)) {
            builder.addAction(0, "Like", viewPendingIntent(
                    "campus://post/" + postId + "?like=" + commentId + "&nid=" + nid + "&tag=" + tag, id));
            builder.addAction(0, "Reply", viewPendingIntent(
                    "campus://post/" + postId + "?reply=" + commentId + "&nid=" + nid + "&tag=" + tag, id));
        } else if (isChat && isUuid(data.get("entity_id"))) {
            Intent reply = new Intent(this, ReplyReceiver.class);
            reply.putExtra("chat", data.get("entity_id"));
            reply.putExtra("nid", nid);
            reply.putExtra("tag", tag);
            // RemoteInput results are appended into the intent — the PI must be MUTABLE
            PendingIntent replyPi = PendingIntent.getBroadcast(
                    this, id, reply,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            RemoteInput input = new RemoteInput.Builder(KEY_REPLY_TEXT)
                    .setLabel("Reply")
                    .build();
            builder.addAction(new NotificationCompat.Action.Builder(0, "Reply", replyPi)
                    .addRemoteInput(input)
                    .setAllowGeneratedReplies(false)
                    .build());
        }

        try {
            manager.notify(tag, id, builder.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked between check and post
        }
    }

    /** Notification taps and action buttons all land in the app through the
     *  campus:// scheme the manifest intent-filter already owns. */
    private PendingIntent viewPendingIntent(String uri, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
        intent.setPackage(getPackageName());
        return PendingIntent.getActivity(
                this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        makeChannel(nm, CHANNEL_DEFAULT, "CAMPUS notifications",
                "Follows, likes, comments, mentions and campus activity");
        makeChannel(nm, CHANNEL_MESSAGES, "Messages",
                "Direct and community chat messages");
    }

    private void makeChannel(NotificationManager nm, String id, String name, String description) {
        NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(description);
        channel.enableVibration(true);
        nm.createNotificationChannel(channel); // idempotent
    }

    /** ISO timestamp from the server payload → the real event time, so the
     *  shade shows age from when it happened, not when FCM delivered. */
    private long parseWhen(String iso) {
        if (iso == null || iso.isEmpty()) return System.currentTimeMillis();
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            return format.parse(iso.substring(0, Math.min(iso.length(), 19))).getTime();
        } catch (ParseException | StringIndexOutOfBoundsException e) {
            return System.currentTimeMillis();
        }
    }

    private static boolean isUuid(String value) {
        return value != null
                && value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }
}
