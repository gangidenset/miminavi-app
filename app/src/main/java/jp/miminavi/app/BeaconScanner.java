package jp.miminavi.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * BLE スキャンを行い、受信中のビーコン一覧を 0.5 秒ごとにまとめて通知する。
 * RSSI は揺れが大きいので、直近数秒の受信値を平均して渡す。
 */
public class BeaconScanner {

    public interface Listener {
        void onSnapshot(String json);
        void onScanError(String message);
    }

    private static final long PUBLISH_MS = 500;
    private static final long SAMPLE_WINDOW_MS = 4000;   // 平均に使う期間
    private static final long FORGET_MS = 8000;          // これ以上受信がなければ一覧から外す
    private static final int MAX_SAMPLES = 20;

    private static final class Sample {
        final long t; final int rssi;
        Sample(long t, int rssi) { this.t = t; this.rssi = rssi; }
    }

    private static final class Tracked {
        BeaconParser.Beacon beacon;
        final ArrayDeque<Sample> samples = new ArrayDeque<>();
        long lastSeen;
        long count;
    }

    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Tracked> beacons = new HashMap<>();
    private final Map<String, Long> others = new HashMap<>(); // ビーコン以外の BLE 機器
    private BluetoothLeScanner scanner;
    private boolean scanning = false;

    public BeaconScanner(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    public boolean isScanning() { return scanning; }

    public BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    @SuppressLint("MissingPermission") // 呼び出し前に MainActivity で権限を確認している
    public void start() {
        if (scanning) return;
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled()) {
            listener.onScanError("Bluetooth がオフです");
            return;
        }
        scanner = a.getBluetoothLeScanner();
        if (scanner == null) {
            listener.onScanError("BLE スキャナーを取得できませんでした");
            return;
        }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0)
                .build();
        try {
            scanner.startScan(null, settings, callback);
            scanning = true;
            main.removeCallbacks(publisher);
            main.postDelayed(publisher, PUBLISH_MS);
        } catch (SecurityException e) {
            listener.onScanError("スキャンの権限がありません");
        }
    }

    @SuppressLint("MissingPermission")
    public void stop() {
        main.removeCallbacks(publisher);
        if (!scanning) return;
        scanning = false;
        try {
            if (scanner != null) scanner.stopScan(callback);
        } catch (Exception ignored) {
            // Bluetooth が先にオフになった場合など
        }
    }

    private final ScanCallback callback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            handle(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult r : results) handle(r);
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
            String msg;
            switch (errorCode) {
                case SCAN_FAILED_ALREADY_STARTED: msg = "スキャンはすでに開始されています"; break;
                case SCAN_FAILED_APPLICATION_REGISTRATION_FAILED:
                    msg = "スキャンを登録できませんでした（短時間に開始・停止を繰り返すと起きます。少し待って再度お試しください）"; break;
                case SCAN_FAILED_FEATURE_UNSUPPORTED: msg = "この端末は BLE スキャンに対応していません"; break;
                default: msg = "スキャンに失敗しました（コード " + errorCode + "）";
            }
            final String m = msg;
            main.post(() -> listener.onScanError(m));
        }
    };

    private void handle(ScanResult r) {
        ScanRecord rec = r.getScanRecord();
        BeaconParser.Beacon b = BeaconParser.parse(rec == null ? null : rec.getBytes());
        long now = SystemClock.elapsedRealtime();
        synchronized (beacons) {
            if (b == null) {
                if (r.getDevice() != null) others.put(r.getDevice().getAddress(), now);
                return;
            }
            String key = b.key();
            Tracked t = beacons.get(key);
            if (t == null) {
                t = new Tracked();
                beacons.put(key, t);
            }
            t.beacon = b;
            t.lastSeen = now;
            t.count++;
            t.samples.addLast(new Sample(now, r.getRssi()));
            while (t.samples.size() > MAX_SAMPLES) t.samples.removeFirst();
        }
    }

    private final Runnable publisher = new Runnable() {
        @Override
        public void run() {
            listener.onSnapshot(snapshot());
            if (scanning) main.postDelayed(this, PUBLISH_MS);
        }
    };

    private String snapshot() {
        long now = SystemClock.elapsedRealtime();
        JSONObject root = new JSONObject();
        JSONArray arr = new JSONArray();
        synchronized (beacons) {
            Iterator<Map.Entry<String, Tracked>> it = beacons.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Tracked> e = it.next();
                Tracked t = e.getValue();
                if (now - t.lastSeen > FORGET_MS) { it.remove(); continue; }
                // 古いサンプルを捨てて平均
                List<Integer> recent = new ArrayList<>();
                for (Sample s : t.samples) if (now - s.t <= SAMPLE_WINDOW_MS) recent.add(s.rssi);
                if (recent.isEmpty()) recent.add(t.samples.peekLast().rssi);
                // 飛び抜けた値に引っぱられないよう、上下 20% を捨ててから平均（トリム平均）
                java.util.Collections.sort(recent);
                int cut = recent.size() >= 5 ? recent.size() / 5 : 0;
                double sum = 0;
                int cnt = 0;
                for (int i = cut; i < recent.size() - cut; i++) { sum += recent.get(i); cnt++; }
                try {
                    JSONObject o = new JSONObject();
                    o.put("key", e.getKey());
                    o.put("type", t.beacon.type);
                    o.put("uuid", t.beacon.uuid);
                    o.put("major", t.beacon.major);
                    o.put("minor", t.beacon.minor);
                    if (t.beacon.instance != null) o.put("instance", t.beacon.instance);
                    o.put("tx", t.beacon.txPower);
                    o.put("rssi", Math.round(sum / cnt * 10) / 10.0);
                    o.put("rssiLast", t.samples.peekLast().rssi);
                    o.put("samples", recent.size());
                    o.put("ageMs", now - t.lastSeen);
                    o.put("count", t.count);
                    arr.put(o);
                } catch (JSONException ignored) { }
            }
            Iterator<Map.Entry<String, Long>> oi = others.entrySet().iterator();
            while (oi.hasNext()) if (now - oi.next().getValue() > FORGET_MS) oi.remove();
            try {
                root.put("scanning", scanning);
                root.put("others", others.size());
                root.put("beacons", arr);
            } catch (JSONException ignored) { }
        }
        return root.toString();
    }
}
