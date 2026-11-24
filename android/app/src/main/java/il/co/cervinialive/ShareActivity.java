package il.co.cervinialive;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * The site hands sharing to the app with
 *   intent://share?k=KEY&g=GROUP&u=UNTIL_MS&l=he#Intent;scheme=cervinialive;package=il.co.cervinialive;end
 * and takes it back with intent://stop. No screen of its own: it asks for
 * the permissions the first time, starts or stops the service, and is gone.
 */
public class ShareActivity extends Activity {
    private static final int REQ = 7;
    private Intent pending;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Uri u = getIntent() != null ? getIntent().getData() : null;
        if (u == null) { finish(); return; }

        if ("stop".equals(u.getHost())) {
            Intent s = new Intent(this, ShareService.class).setAction(ShareService.ACTION_STOP_QUIET);
            try { startService(s); } catch (Exception ignored) { }
            finish();
            return;
        }

        String key = u.getQueryParameter("k");
        long until = 0;
        try { until = Long.parseLong(u.getQueryParameter("u")); } catch (Exception ignored) { }
        if (key == null || key.length() != 48 || until < System.currentTimeMillis()) { finish(); return; }

        pending = new Intent(this, ShareService.class)
                .setAction(ShareService.ACTION_START)
                .putExtra("key", key)
                .putExtra("group", u.getQueryParameter("g"))
                .putExtra("until", until)
                .putExtra("lang", u.getQueryParameter("l"));

        List<String> ask = new ArrayList<>();
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            ask.add(Manifest.permission.ACCESS_FINE_LOCATION);
            ask.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            ask.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (ask.isEmpty()) { start(); return; }
        requestPermissions(ask.toArray(new String[0]), REQ);
    }

    private boolean granted(String p) {
        return ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            start();
        } else {
            boolean he = "he".equals(pending.getStringExtra("lang"));
            Toast.makeText(this, he ? "בלי הרשאת מיקום אי אפשר לשתף כשהמסך כבוי"
                    : "Without location permission, sharing cannot go on with the screen off", Toast.LENGTH_LONG).show();
            finish();
        }
    }

    private void start() {
        try { ContextCompat.startForegroundService(this, pending); } catch (Exception ignored) { }
        finish();
    }
}
