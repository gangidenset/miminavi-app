package jp.miminavi.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 画面は assets/index.html（デモと同じデザイン）を WebView で表示し、
 * BLE スキャン・読み上げ・音声認識・方位センサーなど端末機能をネイティブで提供する。
 */
public class MainActivity extends Activity implements BeaconScanner.Listener, SensorEventListener {

    private static final int REQ_PERMS = 1;
    private static final int REQ_BT = 2;
    private static final int REQ_SPEECH = 3;
    private static final String PREFS = "miminavi";

    private WebView web;
    private BeaconScanner scanner;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private SensorManager sensors;
    private float lastHeading = -999;
    private long lastHeadingAt = 0;
    private boolean started = false;   // 画面が表示中か
    private boolean wantScan = false;  // JS 側からスキャン開始を要求されたか
    private String lastError = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#EEF3F1"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#EEF3F1"));
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Android 15 以降は画面端まで描画されるため、ステータスバー等の分だけ余白をとる
        if (Build.VERSION.SDK_INT >= 35) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // PC の chrome://inspect で確認できる
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "MimiNative");
        web.loadUrl("file:///android_asset/index.html");

        scanner = new BeaconScanner(this, this);
        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(Locale.JAPAN);
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setSpeechRate(1.05f);
            }
        });

        // 戻るボタン：画面内の前の画面へ。ホームならアプリを閉じる
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        web.evaluateJavascript("(window.__back ? window.__back() : false)", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        if (wantScan) ensureReadyAndScan(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Sensor rv = sensors == null ? null : sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rv != null) sensors.registerListener(this, rv, SensorManager.SENSOR_DELAY_UI);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (sensors != null) sensors.unregisterListener(this);
    }

    @Override
    protected void onStop() {
        super.onStop();
        started = false;
        scanner.stop();
        sendStatus();
    }

    @Override
    protected void onDestroy() {
        scanner.stop();
        if (tts != null) tts.shutdown();
        web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 権限と準備

    private String[] requiredPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION};
        }
        return new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION};
    }

    private boolean hasPermissions() {
        for (String p : requiredPermissions()) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    private boolean bluetoothOn() {
        BluetoothAdapter a = scanner.adapter();
        return a != null && a.isEnabled();
    }

    @SuppressWarnings("deprecation")
    private boolean locationOn() {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
        try {
            return Settings.Secure.getInt(getContentResolver(), Settings.Secure.LOCATION_MODE)
                    != Settings.Secure.LOCATION_MODE_OFF;
        } catch (Settings.SettingNotFoundException e) {
            return true;
        }
    }

    /** 権限 → Bluetooth オン → スキャン開始、の順に準備する。 */
    @SuppressLint("MissingPermission")
    private void ensureReadyAndScan(boolean askUser) {
        wantScan = true;
        lastError = "";
        if (!hasPermissions()) {
            if (askUser) requestPermissions(requiredPermissions(), REQ_PERMS);
            sendStatus();
            return;
        }
        if (!bluetoothOn()) {
            if (askUser) {
                try {
                    startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_BT);
                } catch (Exception e) {
                    lastError = "Bluetooth をオンにしてください";
                }
            }
            sendStatus();
            return;
        }
        if (started) scanner.start();
        sendStatus();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMS) {
            if (hasPermissions()) ensureReadyAndScan(true);
            else {
                lastError = "Bluetooth と位置情報の権限が必要です";
                sendStatus();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_BT) {
            ensureReadyAndScan(false);
        } else if (requestCode == REQ_SPEECH) {
            JSONArray arr = new JSONArray();
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<String> list = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (list != null) for (String t : list) arr.put(t);
            }
            js("speech", arr.toString());
        }
    }

    private void sendStatus() {
        try {
            JSONObject o = new JSONObject();
            o.put("permission", hasPermissions());
            o.put("bluetooth", bluetoothOn());
            o.put("location", locationOn());
            o.put("scanning", scanner.isScanning());
            o.put("tts", ttsReady);
            o.put("error", lastError);
            o.put("model", Build.MANUFACTURER + " " + Build.MODEL + " / Android " + Build.VERSION.RELEASE);
            js("status", o.toString());
        } catch (Exception ignored) { }
    }

    /** JS 側の window.__native(type, data) を呼ぶ。 */
    private void js(String type, String json) {
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__native && window.__native('" + type + "'," + json + ")", null));
    }

    // ---------------------------------------------------------------- BeaconScanner.Listener

    @Override
    public void onSnapshot(String json) {
        js("beacons", json);
    }

    @Override
    public void onScanError(String message) {
        lastError = message;
        sendStatus();
    }

    // ---------------------------------------------------------------- 方位（地磁気＋ジャイロ）

    private final float[] rot = new float[9];
    private final float[] ori = new float[3];

    @Override
    public void onSensorChanged(SensorEvent event) {
        SensorManager.getRotationMatrixFromVector(rot, event.values);
        SensorManager.getOrientation(rot, ori);
        float deg = (float) Math.toDegrees(ori[0]);
        if (deg < 0) deg += 360;
        long now = SystemClock.elapsedRealtime();
        float diff = Math.abs(deg - lastHeading);
        if (diff > 180) diff = 360 - diff;
        if (diff >= 2 && now - lastHeadingAt >= 150) {
            lastHeading = deg;
            lastHeadingAt = now;
            js("heading", String.valueOf(Math.round(deg)));
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    // ---------------------------------------------------------------- JS から呼ばれる窓口

    private class Bridge {
        @JavascriptInterface
        public void startScan() {
            runOnUiThread(() -> ensureReadyAndScan(true));
        }

        @JavascriptInterface
        public void setUuidFilter(String uuid) {
            runOnUiThread(() -> scanner.setUuidFilter(uuid));
        }

        @JavascriptInterface
        public void refreshStatus() {
            runOnUiThread(MainActivity.this::sendStatus);
        }

        @JavascriptInterface
        public void speak(String text) {
            if (tts != null && ttsReady) {
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mimi-" + SystemClock.uptimeMillis());
            }
        }

        @JavascriptInterface
        public void stopSpeak() {
            if (tts != null) tts.stop();
        }

        @JavascriptInterface
        public void listen() {
            runOnUiThread(() -> {
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP");
                i.putExtra(RecognizerIntent.EXTRA_PROMPT, "行き先を話してください");
                i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
                try {
                    startActivityForResult(i, REQ_SPEECH);
                } catch (ActivityNotFoundException e) {
                    js("speech", "null");
                }
            });
        }

        @JavascriptInterface
        public String load() {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString("data", "");
        }

        @JavascriptInterface
        public void save(String json) {
            SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            e.putString("data", json).apply();
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void openLocationSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)));
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null));
                startActivity(i);
            });
        }
    }
}
