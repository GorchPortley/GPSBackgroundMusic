package dev.gpsmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

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
    /**
     * Play/Pause from the notification (C2.2). Headset buttons arrive through
     * the MediaSession callback instead; both end in the page's
     * hostPause()/hostResume(), so the page stays the source of truth.
     */
    public static final String ACTION_TOGGLE = "dev.gpsmusic.TOGGLE";
    /**
     * Sent by MainActivity when the page stops because the user paused from
     * the notification or a headset: keep the service, its notification (now
     * with Play) and the MediaSession, so Play can start it again.
     */
    public static final String ACTION_PAUSE = "dev.gpsmusic.PAUSE";

    /** Set by the service so the activity can reflect real state after a restart. */
    public static volatile boolean running = false;

    /**
     * Where audio-focus changes are sent: a JS call run in MainActivity's
     * WebView. Set by the activity while it has one; null otherwise.
     */
    interface Page {
        void call(String js);
    }

    static volatile Page page;

    /**
     * Paused for a transient focus loss (a call, navigation prompt): the page
     * has stopped, but the service and the focus request stay alive so GAIN
     * can start it again. While set, MainActivity ignores the page's
     * setPlaying(false) — that stop is ours, not the user's.
     */
    static volatile boolean resumeOnGain = false;

    /**
     * Set just before the service asks the page to pause on the user's behalf
     * (notification Pause, headset button). MainActivity then turns the page's
     * setPlaying(false) into ACTION_PAUSE rather than ACTION_STOP. A deliberate
     * pause, not a transient loss: it clears resumeOnGain and gives up focus.
     */
    static volatile boolean userPausing = false;

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean hasFocus = false;
    private boolean ducked = false;

    /** Media controls: what the notification and the session currently show. */
    private MediaSession session;
    private boolean playing = false;
    private String scene;

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
            resumeOnGain = false;
            userPausing = false;
            abandonFocus();
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

        if (ACTION_TOGGLE.equals(action)) {
            if (playing) requestPause();
            else requestPlay();
            return START_NOT_STICKY;
        }

        if (ACTION_PAUSE.equals(action)) {
            // The page has stopped at the user's request. A deliberate stop:
            // no resume on GAIN, and the focus goes back to whoever wants it.
            userPausing = false;
            resumeOnGain = false;
            abandonFocus();
            showPaused();
            return START_NOT_STICKY;
        }

        // ACTION_START: playback began, or a scene update while playing. A
        // start without a scene (resuming from a pause) keeps the last one.
        if (intent != null && intent.hasExtra("scene")) scene = intent.getStringExtra("scene");
        playing = true;
        ensureSession();
        updateSession();
        startForeground(NOTIFICATION_ID, buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                        | ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        running = true;
        // Playback proper. Scene updates come through here too; only ask once.
        if (!hasFocus) requestFocus();

        // Deliberately not sticky: if Android does kill us, silently restarting
        // audio in someone's pocket would be worse than staying stopped.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        resumeOnGain = false;
        userPausing = false;
        abandonFocus();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------ audio focus */

    /**
     * Ask for long-term focus as music. willPauseWhenDucked(true) is not
     * "we pause": it tells Android 8+ not to duck us automatically and to
     * deliver LOSS_TRANSIENT_CAN_DUCK instead, so the page can glide its own
     * volume down (nothing pops) rather than have the system cut it.
     */
    private void requestFocus() {
        if (audioManager == null) audioManager = getSystemService(AudioManager.class);
        if (audioManager == null) return;
        if (focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build())
                    .setWillPauseWhenDucked(true)
                    .setOnAudioFocusChangeListener(this::onFocusChange,
                            new Handler(Looper.getMainLooper()))
                    .build();
        }
        // FAILED (e.g. during a call the user chose to play through) is left
        // alone: the user pressed Play, so play.
        hasFocus = audioManager.requestAudioFocus(focusRequest)
                == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (audioManager != null && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        }
        hasFocus = false;
        ducked = false;
    }

    /** Runs on the main looper, which is also the WebView's thread. */
    private void onFocusChange(int change) {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                // Another app is playing now. Stop for good; the page's stop
                // then stops this service, which abandons the request.
                hasFocus = false;
                resumeOnGain = false;
                userPausing = false;   // not the user's pause: stop outright
                ducked = false;
                callPage("hostPause()");
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                hasFocus = false;
                resumeOnGain = true;   // set before the page's stop arrives
                callPage("hostPause()");
                // The page's stop is swallowed while resumeOnGain is set, so
                // show the pause here: Play in the notification, and a
                // headset press, can then end the wait early.
                if (playing) showPaused();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                ducked = true;
                callPage("hostDuck(true)");
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                hasFocus = true;
                if (ducked) {
                    ducked = false;
                    callPage("hostDuck(false)");
                }
                if (resumeOnGain) {
                    resumeOnGain = false;
                    callPage("hostResume()");
                }
                break;
            default:
                break;
        }
    }

    private static void callPage(String method) {
        Page target = page;
        if (target != null) target.call("window.gpsMusic && window.gpsMusic." + method);
    }

    /* --------------------------------------------------------- media controls */

    /**
     * Ask the page to play. Everything goes through the page, which then calls
     * setPlaying(true) back, which lands in ACTION_START above — so the
     * notification and the session only ever show what the page is doing.
     */
    private void requestPlay() {
        if (playing) return;
        callPage("hostResume()");
    }

    /** Ask the page to pause, as a deliberate user stop (see userPausing). */
    private void requestPause() {
        if (!playing) return;
        if (resumeOnGain) {
            // Already stopped for a transient loss; the page will not call
            // back. Turn the wait into a user pause right here.
            resumeOnGain = false;
            abandonFocus();
            showPaused();
            return;
        }
        userPausing = true;
        resumeOnGain = false;
        callPage("hostPause()");
    }

    /** Paused, but still here: the notification offers Play, the session PAUSED. */
    private void showPaused() {
        playing = false;
        updateSession();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
    }

    /**
     * A platform MediaSession (no AndroidX here): it is what headset buttons,
     * Bluetooth controls and the lock-screen player talk to. Its callbacks run
     * on the main looper, like the focus listener.
     */
    private void ensureSession() {
        if (session != null) return;
        session = new MediaSession(this, "GPSMusic");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                requestPlay();
            }

            @Override
            public void onPause() {
                requestPause();
            }
        }, new Handler(Looper.getMainLooper()));
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session.setSessionActivity(PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE));
        session.setActive(true);
    }

    /**
     * State and metadata. The default MediaSession.Callback.onMediaButtonEvent
     * turns a headset PLAY_PAUSE / HOOK press into onPause() or onPlay() from
     * exactly this state and these actions, so both must stay current.
     */
    private void updateSession() {
        if (session == null) return;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
                .build());
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, headline())
                .putString(MediaMetadata.METADATA_KEY_ARTIST, getString(R.string.app_name))
                .build());
    }

    /** "Now playing: <scene>", or "Paused: <scene>". */
    private String headline() {
        boolean known = scene != null && !scene.isEmpty();
        if (playing) {
            return known ? getString(R.string.notification_playing, scene)
                    : getString(R.string.notification_idle);
        }
        return known ? getString(R.string.notification_paused, scene)
                : getString(R.string.notification_paused_idle);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, PlaybackService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_IMMUTABLE);

        Intent toggle = new Intent(this, PlaybackService.class).setAction(ACTION_TOGGLE);
        PendingIntent toggleIntent = PendingIntent.getService(
                this, 3, toggle, PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(headline())
                .setContentText(getString(R.string.app_name))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(content)
                .setVisibility(Notification.VISIBILITY_PUBLIC)   // readable when locked
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(this, playing
                                ? android.R.drawable.ic_media_pause
                                : android.R.drawable.ic_media_play),
                        getString(playing ? R.string.action_pause : R.string.action_play),
                        toggleIntent).build())
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(this,
                                android.R.drawable.ic_menu_close_clear_cancel),
                        getString(R.string.action_stop), stopIntent).build())
                .setOngoing(true)
                .setOnlyAlertOnce(true);

        Notification.MediaStyle style = new Notification.MediaStyle()
                .setShowActionsInCompactView(0);
        if (session != null) style.setMediaSession(session.getSessionToken());
        return builder.setStyle(style).build();
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
