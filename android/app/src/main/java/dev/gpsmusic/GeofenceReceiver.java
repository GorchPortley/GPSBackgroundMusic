package dev.gpsmusic;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingEvent;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Wakes the app when you walk into a place you bound a theme to.
 *
 * Only needed while the app is NOT playing: during playback the foreground
 * service keeps location flowing and the page's own cue polling handles every
 * fence. This covers the other case — the app is closed, you walk into the
 * café you bound "noir" to, and the music should start by itself.
 *
 * The fences are handed over by the page (AndroidHost.setFences) whenever the
 * pack's cues change and each time the page loads. Play Services forgets them
 * on reboot, on "Clear data", and when the app is force-stopped (force-stop
 * cancels every PendingIntent the app owns), so opening the app once is what
 * re-arms them.
 *
 * What happens on a crossing, and why it is two things:
 *
 *   1. PlaybackService is started in "wake" mode. Starting a foreground
 *      service from a geofence transition broadcast is one of Android's
 *      documented exemptions to the background-start ban (Android 12+), so
 *      this is the part that reliably works. The notification it posts says
 *      where you are and "tap to play"; tapping it opens MainActivity with
 *      autoplay=true.
 *
 *   2. MainActivity is launched directly with autoplay=true. On Android 10+
 *      this is a background activity start, and a geofence broadcast is NOT
 *      an exemption for that: the system usually drops it silently (logcat:
 *      "Background activity launch blocked"). It goes through when the app
 *      is already visible or was very recently, and on some OEM builds. The
 *      attempt costs nothing, so it is made; the notification is the honest
 *      fallback. In practice, with the screen off: expect the notification,
 *      and one tap to start the music.
 *
 * Nothing here plays sound by itself — the score lives in the WebView, so
 * audio begins only once MainActivity is running and the page has a fix.
 */
public class GeofenceReceiver extends BroadcastReceiver {

    private static final String TAG = "GeofenceReceiver";

    /** Play Services allows 100 active geofences per app. */
    static final int MAX_FENCES = 100;
    /**
     * Below ~100 m Play Services fences are unreliable (it mostly uses Wi-Fi
     * and cell location to save power); the editor allows 50 m, so accept it
     * but do not go lower. The upper bound is just a sanity limit.
     */
    private static final float MIN_RADIUS_M = 50f;
    private static final float MAX_RADIUS_M = 50_000f;
    private static final int MAX_ID_NAME = 40;

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null || event.hasError()) return;
        if (event.getGeofenceTransition() != Geofence.GEOFENCE_TRANSITION_ENTER) return;

        // Already playing: the page's own cue matching has this covered, and
        // restarting the service would reset its notification text.
        if (PlaybackService.running) return;

        String place = null;
        List<Geofence> hits = event.getTriggeringGeofences();
        if (hits != null && !hits.isEmpty()) place = nameFromId(hits.get(0).getRequestId());

        // (1) Allowed from a geofence broadcast: the tap-to-play notification.
        try {
            context.startForegroundService(new Intent(context, PlaybackService.class)
                    .setAction(PlaybackService.ACTION_WAKE)
                    .putExtra(PlaybackService.EXTRA_PLACE, place));
        } catch (RuntimeException e) {
            // ForegroundServiceStartNotAllowedException (an IllegalStateException)
            // or a SecurityException on a build that disagrees with the docs.
            Log.w(TAG, "Could not start the playback service", e);
        }

        // (2) Best effort: usually blocked on Android 10+ while in the background.
        try {
            context.startActivity(new Intent(context, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(MainActivity.EXTRA_AUTOPLAY, true));
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not launch the activity", e);
        }
    }

    /* ------------------------------------------------------------ register */

    /**
     * Replace the registered fences with the ones in {@code json}: an array of
     * {@code {name, lat, lng, radius}} from the page. The page is not trusted
     * any more than a pack is — every entry is range-checked here, anything
     * malformed is skipped, and at most {@link #MAX_FENCES} are kept.
     */
    static void setFences(Context context, String json) {
        Context app = context.getApplicationContext();
        GeofencingClient client = LocationServices.getGeofencingClient(app);
        PendingIntent pending = pendingIntent(app);

        List<Geofence> fences = parse(json);

        // Always clear first, so a deleted cue stops waking the app — and only
        // add once the removal has finished, or it could land after the add
        // and wipe the new set (both are keyed by the same PendingIntent).
        client.removeGeofences(pending).addOnCompleteListener(done -> {
            if (fences.isEmpty()) return;

            // Fine location is required to add fences at all; without
            // background location they are accepted but never fire while
            // the app is closed.
            if (app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                return;
            }

            GeofencingRequest request = new GeofencingRequest.Builder()
                    // No initial trigger: saving a cue where you stand must
                    // not count as "walking in" and start the music under
                    // your thumb.
                    .setInitialTrigger(0)
                    .addGeofences(fences)
                    .build();
            try {
                client.addGeofences(request, pending)
                        .addOnFailureListener(e -> Log.w(TAG, "addGeofences failed", e));
            } catch (SecurityException e) {
                Log.w(TAG, "No permission to add geofences", e);
            }
        });
    }

    private static List<Geofence> parse(String json) {
        List<Geofence> out = new ArrayList<>();
        JSONArray list;
        try {
            list = new JSONArray(json == null ? "[]" : json);
        } catch (Exception e) {
            return out;
        }

        for (int i = 0; i < list.length() && out.size() < MAX_FENCES; i++) {
            JSONObject f = list.optJSONObject(i);
            if (f == null) continue;
            double lat = f.optDouble("lat", Double.NaN);
            double lng = f.optDouble("lng", Double.NaN);
            double radius = f.optDouble("radius", Double.NaN);
            if (!Double.isFinite(lat) || lat < -90 || lat > 90) continue;
            if (!Double.isFinite(lng) || lng < -180 || lng > 180) continue;
            if (!Double.isFinite(radius) || radius <= 0) continue;
            float r = (float) Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, radius));

            out.add(new Geofence.Builder()
                    .setRequestId(requestId(out.size(), f.optString("name", "")))
                    .setCircularRegion(lat, lng, r)
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER)
                    .setLoiteringDelay(0)
                    .build());
        }
        return out;
    }

    /** "<index>:<name>", name truncated — stable for the same pack, unique within it. */
    private static String requestId(int index, String name) {
        String clean = name == null ? "" : name.replaceAll("\\p{Cntrl}", "").trim();
        if (clean.length() > MAX_ID_NAME) clean = clean.substring(0, MAX_ID_NAME);
        return index + ":" + clean;
    }

    private static String nameFromId(String id) {
        if (id == null) return null;
        int colon = id.indexOf(':');
        String name = colon < 0 ? "" : id.substring(colon + 1);
        return name.isEmpty() ? null : name;
    }

    /**
     * Must be MUTABLE: Play Services fills in the transition and the
     * triggering fences as extras, and on Android 12+ an immutable
     * PendingIntent would arrive with them stripped. It is explicit (names
     * this receiver), which is what Android 14 requires of a mutable one.
     */
    private static PendingIntent pendingIntent(Context context) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(context, 0,
                new Intent(context, GeofenceReceiver.class), flags);
    }
}
