package jp.miminavi.app;

/**
 * BLE 広告パケット（スキャンレコードの生バイト列）からビーコン情報を取り出す。
 * Android API に依存しない純粋な Java なので、PC 上でも単体テストできる。
 *
 * 対応フォーマット:
 *  - iBeacon（iPhone の Beacon Simulator などが送信する形式）
 *  - AltBeacon
 *  - Eddystone-UID
 */
public final class BeaconParser {

    private BeaconParser() {}

    /** 解析結果。txPower は「1m 地点での RSSI（dBm）」に正規化した値。 */
    public static final class Beacon {
        public final String type;   // "iBeacon" / "AltBeacon" / "Eddystone"
        public final String uuid;   // iBeacon/AltBeacon: UUID, Eddystone: namespace
        public final int major;     // Eddystone では -1
        public final int minor;     // Eddystone では -1
        public final String instance; // Eddystone の instance。その他は null
        public final int txPower;

        Beacon(String type, String uuid, int major, int minor, String instance, int txPower) {
            this.type = type;
            this.uuid = uuid;
            this.major = major;
            this.minor = minor;
            this.instance = instance;
            this.txPower = txPower;
        }

        /** 端末の MAC アドレスは iPhone 側で変わるため、ビーコンの識別子でキーを作る。 */
        public String key() {
            if (instance != null) return type + ":" + uuid + ":" + instance;
            return type + ":" + uuid + ":" + major + ":" + minor;
        }
    }

    private static final int COMPANY_APPLE = 0x004C;
    private static final int EDDYSTONE_UUID = 0xFEAA;

    /** スキャンレコード全体を解析する。ビーコンでなければ null。 */
    public static Beacon parse(byte[] record) {
        if (record == null) return null;
        int i = 0;
        while (i < record.length) {
            int len = record[i] & 0xFF;
            if (len == 0 || i + 1 >= record.length) break;
            int type = record[i + 1] & 0xFF;
            int start = i + 2;
            int end = i + 1 + len; // 排他的な終端
            if (end > record.length) break;

            if (type == 0xFF && end - start >= 2) {
                int company = (record[start] & 0xFF) | ((record[start + 1] & 0xFF) << 8);
                Beacon b = parseManufacturer(company, record, start + 2, end);
                if (b != null) return b;
            } else if (type == 0x16 && end - start >= 2) {
                int svc = (record[start] & 0xFF) | ((record[start + 1] & 0xFF) << 8);
                if (svc == EDDYSTONE_UUID) {
                    Beacon b = parseEddystone(record, start + 2, end);
                    if (b != null) return b;
                }
            }
            i = end;
        }
        return null;
    }

    /** メーカー固有データ（会社IDの直後から）を解析する。 */
    static Beacon parseManufacturer(int company, byte[] d, int s, int e) {
        int n = e - s;
        // iBeacon: 0x02 0x15 + UUID(16) + major(2) + minor(2) + txPower(1) = 23 バイト
        if (company == COMPANY_APPLE && n >= 23
                && (d[s] & 0xFF) == 0x02 && (d[s + 1] & 0xFF) == 0x15) {
            String uuid = uuid(d, s + 2);
            int major = u16be(d, s + 18);
            int minor = u16be(d, s + 20);
            int tx = d[s + 22]; // 符号付き
            return new Beacon("iBeacon", uuid, major, minor, null, normalizeTx(tx, -59));
        }
        // AltBeacon: 0xBE 0xAC + ID1(16) + ID2(2) + ID3(2) + refRSSI(1) + reserved(1)
        if (n >= 24 && (d[s] & 0xFF) == 0xBE && (d[s + 1] & 0xFF) == 0xAC) {
            String uuid = uuid(d, s + 2);
            int major = u16be(d, s + 18);
            int minor = u16be(d, s + 20);
            int tx = d[s + 22];
            return new Beacon("AltBeacon", uuid, major, minor, null, normalizeTx(tx, -59));
        }
        return null;
    }

    /** Eddystone-UID: frame 0x00 + tx@0m(1) + namespace(10) + instance(6) */
    static Beacon parseEddystone(byte[] d, int s, int e) {
        if (e - s < 18 || (d[s] & 0xFF) != 0x00) return null;
        int tx0 = d[s + 1];
        String ns = hex(d, s + 2, 10);
        String inst = hex(d, s + 12, 6);
        // 0m 地点の値から 1m 地点の値へ（約 -41dB）
        return new Beacon("Eddystone", ns, -1, -1, inst, normalizeTx(tx0 - 41, -59));
    }

    /** 送信側で未設定（0 や正の値）のときは一般的な既定値を使う。 */
    private static int normalizeTx(int tx, int fallback) {
        if (tx >= 0 || tx < -100) return fallback;
        return tx;
    }

    private static int u16be(byte[] d, int i) {
        return ((d[i] & 0xFF) << 8) | (d[i + 1] & 0xFF);
    }

    private static String uuid(byte[] d, int s) {
        String h = hex(d, s, 16);
        return (h.substring(0, 8) + "-" + h.substring(8, 12) + "-" + h.substring(12, 16) + "-"
                + h.substring(16, 20) + "-" + h.substring(20, 32)).toUpperCase();
    }

    private static String hex(byte[] d, int s, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = 0; i < len; i++) {
            sb.append(String.format("%02X", d[s + i] & 0xFF));
        }
        return sb.toString();
    }
}
