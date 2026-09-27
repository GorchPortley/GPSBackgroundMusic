package dev.gpsmusic;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * A WebView host for the same web app the server serves — no fork, no build
 * step, the contents of `public/` copied verbatim into assets.
 *
 * The one thing worth understanding here is the origin. Loading the files as
 * `file://` would be simplest and would also break the app: a file:// page is
 * not a secure context, so the browser refuses geolocation and refuses to
 * register a service worker. Instead the pages are served over a real https
 * origin that is intercepted locally and answered from assets. Nothing leaves
 * the device, but the page is treated as secure, so everything works.
 */
public class MainActivity extends Activity {

    /** Reserved by Android for exactly this purpose; never resolves publicly. */
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String ASSET_ROOT = "www/";

    private static final int REQ_LOCATION = 100;
    private static final int REQ_BACKGROUND = 101;
    private static final int REQ_NOTIFICATIONS = 102;
    private static final int REQ_FILE = 200;

    private WebView web;

    /** Held between opening the file picker and its result coming back. */
    private ValueCallback<Uri[]> pendingFileCallback;

    /** A pack opened from another app, waiting for the page to be ready. */
    private String pendingPackJson;
    private String pendingPackError;
    private boolean pageReady = false;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Draw behind the system bars; the app is a dark full-bleed HUD.
        getWindow().setStatusBarColor(0xFF0B0F14);
        getWindow().setNavigationBarColor(0xFF0B0F14);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // packs live in localStorage
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);           // assets come through the interceptor
        s.setAllowContentAccess(false);

        web.setBackgroundColor(0xFF0B0F14);
        web.addJavascriptInterface(new Bridge(), "AndroidHost");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!ORIGIN.equals(uri.getScheme() + "://" + uri.getAuthority())) {
                    return null;   // real network request, let it through
                }
                return serveAsset(uri.getPath());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                deliverPendingPack();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (ORIGIN.equals(uri.getScheme() + "://" + uri.getAuthority())) return false;
                // Anything genuinely external opens in a real browser.
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback callback) {
                // The Android permission is the real gate; do not ask twice.
                boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
                callback.invoke(origin, granted, false);
            }

            /**
             * Without this, <input type="file"> silently does nothing in a
             * WebView — no picker opens and no error is raised, so "Import
             * pack" just looks broken. The WebView will not open a chooser on
             * its own; the app has to launch one and hand the result back.
             */
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;

                // Deliberately */* rather than application/json. A .json saved
                // by Dropbox or a browser often arrives typed as text/plain or
                // octet-stream, and a strict filter greys it out in the picker.
                // The pack is validated on read anyway.
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*");

                try {
                    startActivityForResult(
                            Intent.createChooser(pick, getString(R.string.pick_pack)),
                            REQ_FILE);
                    return true;
                } catch (Exception e) {
                    pendingFileCallback = null;
                    return false;
                }
            }
        });

        requestPermissions();
        readPackFromIntent(getIntent());
        web.loadUrl(ORIGIN + "/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readPackFromIntent(intent);
        deliverPendingPack();
    }

    /**
     * Pull a pack out of an incoming VIEW or SEND intent.
     *
     * Read here rather than handing the URI to the page: the grant that comes
     * with the intent belongs to this activity, and it does not survive being
     * passed into the WebView.
     */
    private void readPackFromIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = Intent.ACTION_SEND.equals(intent.getAction())
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM)
                : intent.getData();
        if (uri == null) return;

        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            int total = 0;
            while ((read = in.read(chunk)) != -1) {
                total += read;
                // A pack is a few tens of KB; anything past this is not one.
                if (total > 2 * 1024 * 1024) return;
                buffer.write(chunk, 0, read);
            }
            pendingPackJson = buffer.toString("UTF-8");
        } catch (Exception e) {
            // A file:// URI from a file manager lands here as EACCES: the app
            // has no storage permission, so the read is refused. It arrives
            // wrapped as FileNotFoundException rather than SecurityException,
            // hence matching on the message.
            String detail = String.valueOf(e.getMessage());
            boolean denied = e instanceof SecurityException
                    || detail.contains("EACCES")
                    || detail.contains("Permission denied");
            pendingPackError = denied
                    ? "Could not read that file directly. Use Share → GPS Music "
                      + "from the app holding it, or the Paste button."
                    : "Could not read that pack: " + detail;
        }
    }

    /** Hand a waiting pack to the page, once there is a page to hand it to. */
    private void deliverPendingPack() {
        if (!pageReady || web == null) return;

        if (pendingPackError != null) {
            String message = pendingPackError;
            pendingPackError = null;
            web.evaluateJavascript(
                    "window.gpsMusic && window.gpsMusic.ui.setPackHint("
                            + JSONObject.quote(message) + ")", null);
            return;
        }

        if (pendingPackJson == null) return;
        // JSONObject.quote produces a correctly escaped JS string literal, which
        // hand-rolled escaping of arbitrary JSON reliably gets wrong.
        String js = "window.gpsMusic && window.gpsMusic.importPackText("
                + JSONObject.quote(pendingPackJson) + ")";
        pendingPackJson = null;
        web.evaluateJavascript(js, null);
    }

    /** Map a URL path onto a file in assets/www, refusing anything that escapes it. */
    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        String rel = path.startsWith("/") ? path.substring(1) : path;

        // No traversal, no absolute paths.
        if (rel.contains("..") || rel.startsWith("/")) {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                    new HashMap<>(), null);
        }

        try {
            InputStream in = getAssets().open(ASSET_ROOT + rel);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mimeOf(rel), "utf-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new HashMap<>(), null);
        }
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = path.substring(dot + 1).toLowerCase();
        String mime = MIME.get(ext);
        return mime == null ? "application/octet-stream" : mime;
    }

    private void requestPermissions() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        } else {
            requestBackgroundLocation();
        }

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_NOTIFICATIONS);
        }
    }

    /**
     * Background location has to be asked for on its own, after foreground
     * location is already granted — Android rejects the pair in one request.
     */
    private void requestBackgroundLocation() {
        if (checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                    REQ_BACKGROUND);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQ_LOCATION && results.length > 0
                && results[0] == PackageManager.PERMISSION_GRANTED) {
            requestBackgroundLocation();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFileCallback != null) {
                // Must always be answered, even on cancel — leaving the promise
                // unresolved wedges the file input for the rest of the session.
                pendingFileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        // Leaving the service running without a UI would be a stuck notification.
        stopService(new Intent(this, PlaybackService.class));
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * Deliberately does NOT call web.onPause(): that is what would suspend the
     * audio graph when the screen goes off, which is the whole problem being
     * solved here. The foreground service keeps the process alive instead.
     */
    @Override
    protected void onPause() {
        super.onPause();
    }

    /** What the page can ask the host to do. */
    private class Bridge {
        @JavascriptInterface
        public void setPlaying(boolean playing) {
            Intent intent = new Intent(MainActivity.this, PlaybackService.class)
                    .setAction(playing ? PlaybackService.ACTION_START : PlaybackService.ACTION_STOP);
            if (playing) startForegroundService(intent);
            else startService(intent);
        }

        @JavascriptInterface
        public void setScene(String scene) {
            PlaybackService.updateScene(MainActivity.this, scene);
        }

        /** Lets the page know it does not need a screen wake lock here. */
        @JavascriptInterface
        public boolean hasBackgroundAudio() {
            return true;
        }
    }
}
