package il.co.cervinialive;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends the position to the friend group while the phone is in a pocket.
 * Started only from the site, by the user; a notification shows all the
 * time that it runs, with a Stop button. It ends by itself at the time the
 * user chose, or as soon as the server says the sharing is over (stopped
 * from the site, the group left). It never holds the user's sign-in: only a
 * key that can move his position in that one group, until that time.
 */
public class ShareService extends Service {
    static final String ACTION_START = "il.co.cervinialive.SHARE_START";
    static final String ACTION_STOP = "il.co.cervinialive.SHARE_STOP";
    static final String ACTION_STOP_QUIET = "il.co.cervinialive.SHARE_STOP_QUIET";

    private static final String SB_URL = "https://cdgqodtbdhsqkvcgcdlm.supabase.co/rest/v1/rpc/";
    private static final String SB_KEY = "sb_publishable_B4HOCQF3IxN_6Ojz1_ctnA_k6JEAR4g";
    private static final String CHANNEL = "share";
    private static final int NOTE_ID = 41;
    private static final long EVERY_MS = 30_000;

    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private FusedLocationProviderClient fused;
    private LocationCallback callback;
    private String key, group, lang;
    private long until;
    private final Runnable timeUp = this::stopAll;

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(a)) {
            final String k = key;
            if (k != null) net.execute(() -> rpc("cl_loc_bg_stop", "{\"p_key\":\"" + k + "\"}"));
            stopAll();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP_QUIET.equals(a)) { stopAll(); return START_NOT_STICKY; }
        if (!ACTION_START.equals(a) || intent.getStringExtra("key") == null) {
            // restarted by the system without the key: nothing to do
            if (key == null) stopAll();
            return START_NOT_STICKY;
        }

        key = intent.getStringExtra("key");
        group = intent.getStringExtra("group");
        lang = intent.getStringExtra("lang");
        until = intent.getLongExtra("until", 0);

        try {
            ServiceCompat.startForeground(this, NOTE_ID, note(),
                    Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0);
        } catch (Exception e) {   // no permission after all: say so and leave
            final String why = e.getClass().getSimpleName() + " " + e.getMessage();
            main.post(() -> android.widget.Toast.makeText(getApplicationContext(),
                    (he() ? "השיתוף לא הופעל: " : "Sharing did not start: ") + why, android.widget.Toast.LENGTH_LONG).show());
            stopSelf();
            return START_NOT_STICKY;
        }
        main.post(() -> android.widget.Toast.makeText(getApplicationContext(),
                he() ? "📍 השיתוף פעיל גם כשהמסך כבוי" : "📍 Sharing goes on with the screen off", android.widget.Toast.LENGTH_SHORT).show());
        main.removeCallbacks(timeUp);
        main.postDelayed(timeUp, Math.max(1000, until - System.currentTimeMillis()));
        listen();
        return START_NOT_STICKY;
    }

    private boolean he() { return !"en".equals(lang); }

    private Notification note() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL,
                    he() ? "שיתוף מיקום עם חברים" : "Sharing location with friends", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription(he() ? "מוצג כל זמן שהמיקום שלך נשלח לקבוצת החברים"
                    : "Shown for as long as your location is sent to your friend group");
            nm.createNotificationChannel(ch);
        }
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, ShareService.class).setAction(ACTION_STOP), fl);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = open != null ? PendingIntent.getActivity(this, 2, open, fl) : null;
        String end = new SimpleDateFormat("HH:mm", Locale.US).format(new Date(until));
        String g = group != null && !group.isEmpty() ? group : (he() ? "הקבוצה" : "your group");
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(he() ? "📍 משתף מיקום עם “" + g + "”" : "📍 Sharing location with “" + g + "”")
                .setContentText(he() ? "עד " + end + " · גם כשהמסך כבוי" : "Until " + end + " · also with the screen off")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openPi)
                .addAction(0, he() ? "עצור" : "Stop", stop)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    private void listen() {
        if (fused == null) fused = LocationServices.getFusedLocationProviderClient(this);
        if (callback != null) fused.removeLocationUpdates(callback);
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult r) {
                Location l = r.getLastLocation();
                if (l != null) push(l);
            }
        };
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, EVERY_MS)
                .setMinUpdateIntervalMillis(15_000)
                .build();
        try {
            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (SecurityException e) {
            stopAll();
        }
    }

    private void push(Location l) {
        final String k = key;
        if (k == null) return;
        final String body = String.format(Locale.US,
                "{\"p_key\":\"%s\",\"p_lat\":%.6f,\"p_lon\":%.6f,\"p_acc\":%s}",
                k, l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? String.valueOf(Math.round(l.getAccuracy())) : "null");
        net.execute(() -> {
            String res = rpc("cl_loc_bg_push", body);
            // "null": the sharing is over on the server - stop here too
            if (res != null && res.trim().equals("null")) main.post(this::stopAll);
        });
    }

    /** POST to a Supabase function; the answer, or null on a network error. */
    private String rpc(String fn, String json) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(SB_URL + fn).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15_000);
            c.setReadTimeout(15_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("apikey", SB_KEY);
            c.setRequestProperty("Authorization", "Bearer " + SB_KEY);
            try (OutputStream o = c.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            if (code >= 400) return code < 500 ? "null" : null;
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                return new String(b.toByteArray(), StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void stopAll() {
        main.removeCallbacks(timeUp);
        if (fused != null && callback != null) fused.removeLocationUpdates(callback);
        callback = null;
        key = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (fused != null && callback != null) fused.removeLocationUpdates(callback);
        net.shutdown();
        super.onDestroy();
    }
}
