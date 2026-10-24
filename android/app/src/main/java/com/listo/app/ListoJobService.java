package com.listo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Periodic background check for the "shopping done" stamp.
 *
 * The WebView part of the app reports every last_done value it syncs to
 * SharedPreferences (see MainActivity.ListoBridge). This job polls
 * /api/listo/api/list roughly every 15 minutes (JobScheduler minimum)
 * and posts a system notification when the server's stamp is one this
 * device has not seen — i.e. someone else finished the shopping while
 * this app was closed.
 */
public class ListoJobService extends JobService {

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    check();
                } catch (Exception ignored) {
                    // Offline, HA down, … — retry at the next scheduled run.
                }
                jobFinished(params, false);
            }
        }).start();
        return true;  // work happens on the background thread
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;  // do not reschedule mid-run; the period stands
    }

    private void check() throws Exception {
        SharedPreferences prefs = getSharedPreferences("listo", MODE_PRIVATE);
        String base = prefs.getString("ha_base", "");
        if (base.isEmpty()) return;
        String token = prefs.getString("token", "");
        String seen = prefs.getString("seen_done", "");

        HttpURLConnection c = (HttpURLConnection)
                new URL(base + "/api/listo/api/list").openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            if (!token.isEmpty()) c.setRequestProperty("X-Listo-Token", token);
            if (c.getResponseCode() != 200) return;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] tmp = new byte[4096];
            int n;
            while ((n = in.read(tmp)) > 0) buf.write(tmp, 0, n);
            String lastDone = new JSONObject(buf.toString("UTF-8"))
                    .optString("last_done");
            // First successful fetch only primes the stamp — do not
            // notify for a shopping run that may be days old.
            if (!prefs.getBoolean("primed", false)) {
                prefs.edit().putBoolean("primed", true)
                     .putString("seen_done", lastDone).apply();
                return;
            }
            if (lastDone.isEmpty() || lastDone.equals(seen)) return;

            prefs.edit().putString("seen_done", lastDone).apply();
            // The app is open and already shows the emptied list — no
            // need to shout about it in the shade.
            if (!MainActivity.foreground) notifyDone();
        } finally {
            c.disconnect();
        }
    }

    private void notifyDone() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    "listo", getString(R.string.app_name),
                    NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, "listo")
                : new Notification.Builder(this);
        // Prefer the localized strings the PWA pushed via the bridge;
        // the bundled resources are the fallback until first sync.
        android.content.SharedPreferences prefs =
                getSharedPreferences("listo", MODE_PRIVATE);
        String title = prefs.getString("notif_title",
                getString(R.string.notif_done_title));
        String text = prefs.getString("notif_text",
                getString(R.string.notif_done_text));
        b.setSmallIcon(R.drawable.listo_icon)
         .setContentTitle(title)
         .setContentText(text)
         .setAutoCancel(true)
         .setContentIntent(pi);
        nm.notify(1, b.build());
    }
}
