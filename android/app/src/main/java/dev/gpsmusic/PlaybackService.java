package dev.gpsmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

/**
 * Keeps the app alive while it is playing.
 *
 * This is the entire reason the project is wrapped in an APK. In a browser —
 * including an installed PWA — locking the phone suspends the page: Web Audio
 * stops and geolocation stops arriving. The usual workaround is a screen wake
 * lock, which works but keeps the display lit for the length of a walk and
 * flattens the battery.
 *
 * A foreground service solves both properly. Android will not suspend or kill
 * a process that owns one, so the audio graph keeps running and location keeps
 * being delivered with the screen off. The cost is a permanent notification,
 * which is the deal Android offers and a fair one.
 *
 * Two types are declared:
 *   mediaPlayback — this is audio the user asked for, keep it running
 *   location      — and it needs position while backgrounded
 */
public class PlaybackService extends Service {

    private static final String CHANNEL_ID = "playback";
    private static final int NOTIFICATION_ID = 1;

    public static final String ACTION_START = "dev.gpsmusic.START";
    public static final String ACTION_STOP = "dev.gpsmusic.STOP";
    /**
     * Started by GeofenceReceiver when a bound place is entered with the app
     * closed. Nothing is playing yet: the notification says where you are and
     * opens the app with autoplay=true, because Android 10+ usually blocks the
     * receiver from opening the activity itself.
     */
    public static final String ACTION_WAKE = "dev.gpsmusic.WAKE";
    public static final String EXTRA_PLACE = "place";

    /** Set by the service so the activity can reflect real state after a restart. */
    public static volatile boolean running = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.channel_name),
                    // Low: no sound, no heads-up. It is a status row, not an alert.
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.channel_description));
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            running = false;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_WAKE.equals(action)) {
            // mediaPlayback only: a location-type service started from the
            // background needs background-location access on Android 14+,
            // and this notification does not need location. Playback proper
            // re-types the service with ACTION_START once the page is up.
            startForeground(NOTIFICATION_ID,
                    buildWakeNotification(intent.getStringExtra(EXTRA_PLACE)),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            running = true;
            return START_NOT_STICKY;
        }

        String scene = intent == null ? null : intent.getStringExtra("scene");
        startForeground(NOTIFICATION_ID, buildNotification(scene),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                        | ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        running = true;

        // Deliberately not sticky: if Android does kill us, silently restarting
        // audio in someone's pocket would be worse than staying stopped.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    private Notification buildNotification(String scene) {
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, PlaybackService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_IMMUTABLE);

        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(scene == null || scene.isEmpty()
                        ? getString(R.string.notification_idle) : scene)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(content)
                .addAction(new Notification.Action.Builder(
                        null, getString(R.string.action_stop), stopIntent).build())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private Notification buildWakeNotification(String place) {
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_AUTOPLAY, true);
        PendingIntent content = PendingIntent.getActivity(
                this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent stop = new Intent(this, PlaybackService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_IMMUTABLE);

        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(place == null || place.isEmpty()
                        ? getString(R.string.notification_wake_generic)
                        : getString(R.string.notification_wake, place))
                .setContentText(getString(R.string.notification_wake_tap))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(content)
                .setAutoCancel(false)
                .addAction(new Notification.Action.Builder(
                        null, getString(R.string.action_stop), stopIntent).build())
                .setOngoing(true)
                .build();
    }

    /** Update the notification text without restarting the service. */
    static void updateScene(Context context, String scene) {
        if (!running) return;
        context.startForegroundService(
                new Intent(context, PlaybackService.class)
                        .setAction(ACTION_START)
                        .putExtra("scene", scene));
    }
}
