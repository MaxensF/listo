package com.listo.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;

/**
 * Minimal single-purpose wrapper: a fullscreen WebView running the Listo
 * PWA bundled inside the APK (file:///android_asset/index.html).
 *
 * Why bundled assets instead of loading the remote page: the app must
 * always open, even with zero connectivity — the WebView can never end
 * up on a black "page not found" screen. The shopping list itself is
 * fetched from / cached against the Home Assistant API and persisted in
 * localStorage, so the last downloaded list survives app restarts.
 *
 * Why a WebView app at all: it gives Listo its own package name
 * (com.listo.app), so Tailscale split-tunneling can route *this app
 * only* through the VPN — Chrome stays untouched.
 *
 * On top of that, a JobScheduler task polls the HA API and raises a
 * system notification when someone else finishes the shopping run
 * (see ListoJobService). The page hands the API base URL + token to the
 * ListoBridge JS interface so the background job can authenticate.
 */
public class MainActivity extends Activity {

    // The bundled entry point (assets = custom_components/listo/www).
    private static final String APP_URL = "file:///android_asset/index.html";
    private static final int JOB_ID = 1;
    private static final int REQ_PHOTO = 42;

    /** True while the WebView is visible — the job stays quiet then. */
    static volatile boolean foreground;

    private WebView webView;

    // In-flight <input type=file> request (loyalty-card photo scan).
    private ValueCallback<Uri[]> fileCallback;
    private Uri pendingPhotoUri;

    /**
     * window.ListoBridge — called from app.js after every sync so the
     * background job can authenticate and knows which last_done stamp
     * this device already saw (no self-notification).
     */
    static class ListoBridge {
        private final SharedPreferences prefs;

        ListoBridge(Activity a) {
            prefs = a.getSharedPreferences("listo", MODE_PRIVATE);
        }

        @JavascriptInterface
        public void configure(String base, String token) {
            prefs.edit()
                 .putString("ha_base", base)
                 .putString("token", token)
                 .apply();
        }

        @JavascriptInterface
        public void markDone(String stamp) {
            prefs.edit().putString("seen_done", stamp).apply();
        }

        @JavascriptInterface
        public void setNotifText(String title, String text) {
            // Localized "shopping done" strings pushed by the PWA so the
            // background job's notification follows the app language.
            prefs.edit()
                 .putString("notif_title", title)
                 .putString("notif_text", text)
                 .apply();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);      // the PWA is a JS app
        s.setDomStorageEnabled(true);      // localStorage = offline state
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Required: pages loaded from file:// cannot reach the network
        // otherwise (fetch/EventSource to the HA API would be blocked).
        // Safe here: the only file:// content is our bundled asset.
        s.setAllowUniversalAccessFromFileURLs(true);

        webView.addJavascriptInterface(new ListoBridge(this), "ListoBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Any http(s) navigation (recipe links) goes to the system
                // browser — the app itself only ever loads file:// assets.
                String u = req.getUrl().toString();
                if (u.startsWith("http://") || u.startsWith("https://")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
                    } catch (Exception ignored) { }
                    return true;
                }
                // Anything that is not a bundled asset (intent://,
                // javascript:, foreign file://, …) must never navigate.
                return !u.startsWith("file:///android_asset/");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Seed the HA base URL on first run (Settings still lets the
                // user change it), then trigger a sync if the page is up.
                String js = "(function(){try{"
                        + "var k='listo-ha-base';"
                        + "if(!localStorage.getItem(k))localStorage.setItem(k,'"
                        + getString(R.string.ha_base) + "');"
                        + "}catch(e){}"
                        + "if(window.listoFlush)window.listoFlush();"
                        + "})()";
                view.evaluateJavascript(js, null);
            }
        });

        // window.open(target=_blank) would otherwise go nowhere in a bare
        // WebView: forward it to the system browser instead.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                WebView.HitTestResult res = view.getHitTestResult();
                String url = res != null ? res.getExtra() : null;
                if (url != null) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) { }
                }
                return false;
            }

            // <input type=file capture> (loyalty-card scan): offer the
            // camera plus a gallery pick in one chooser. The photo lands
            // in our private PhotoProvider, so no storage permission is
            // needed; the WebView reads the content:// URI back.
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                pendingPhotoUri = PhotoProvider.uriFor("scan.jpg");
                Intent takePic = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                takePic.putExtra(MediaStore.EXTRA_OUTPUT, pendingPhotoUri);
                takePic.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                Intent chooser =
                        Intent.createChooser(pick, getString(R.string.choose_photo));
                if (takePic.resolveActivity(getPackageManager()) != null) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS,
                            new Intent[]{takePic});
                }
                try {
                    startActivityForResult(chooser, REQ_PHOTO);
                } catch (android.content.ActivityNotFoundException e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    pendingPhotoUri = null;
                }
                return true;
            }
        });

        scheduleDoneCheck();
        askNotificationPermission();
        webView.loadUrl(APP_URL);
    }

    // Periodic poll for the "shopping done" stamp (see ListoJobService).
    // setPersisted + RECEIVE_BOOT_COMPLETED keep it alive across reboots;
    // scheduling an identical JobInfo is a no-op, so this is idempotent.
    private void scheduleDoneCheck() {
        JobScheduler js = getSystemService(JobScheduler.class);
        js.schedule(new JobInfo.Builder(JOB_ID,
                new ComponentName(this, ListoJobService.class))
                .setPeriodic(15 * 60 * 1000)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    // Android 13+ needs a runtime grant, else the notification is dropped
    // silently. Also registers the channel early on API 26+.
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(
                    "listo", getString(R.string.app_name),
                    NotificationManager.IMPORTANCE_DEFAULT));
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        // File-chooser result: a gallery pick arrives in `data`, a camera
        // shot just signals OK (the photo went to pendingPhotoUri).
        if (req == REQ_PHOTO && fileCallback != null) {
            Uri[] out = null;
            if (res == RESULT_OK) {
                if (data != null && data.getData() != null) {
                    out = WebChromeClient.FileChooserParams.parseResult(res, data);
                } else if (pendingPhotoUri != null) {
                    out = new Uri[]{pendingPhotoUri};
                }
            }
            fileCallback.onReceiveValue(out);
            fileCallback = null;
            pendingPhotoUri = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        foreground = false;
    }

    @Override
    public void onBackPressed() {
        // The PWA is a single page, so WebView history never applies.
        // Ask the page to close its topmost overlay instead; only when
        // nothing is open (main screen) do we let Android exit the app.
        webView.evaluateJavascript(
            "(function(){return window.__listoBack?window.__listoBack():false})()",
            r -> {
                if (!"true".equals(r)) {
                    super.onBackPressed();
                }
            });
    }
}
