# ミミナビ（Android 最小版）

「耳だけで、迷わないスマートナビゲーション」の最小ゴール版です。

- Android アプリとして起動する
- iPhone の Beacon Simulator が送る iBeacon を受信する
- 事業所（福岡支店 4F）の図面を持ち、図面の B-01〜B-13 に置いた iPhone から現在地を推定する
- 行き先（会議室・受付・給湯室・トイレなど 12 か所）を声か文字で伝えると、ルートを計算して音声で案内する

画面のデザインはデモ（ミミナビ.html）に合わせています。

## APK のダウンロード

main に変更が入るたびに GitHub Actions でビルドされ、次の URL の APK が新しくなります。

https://github.com/gangidenset/miminavi-app/releases/download/latest/miminavi.apk

## 構成

| 場所 | 内容 |
|---|---|
| `map/floor.drawio` | **フロアマップ（draw.io）**。図面を変えるときはこれを編集する |
| `tools/drawio_to_map.py` | draw.io → アプリ用地図データ（`map.js`）の変換ツール。ビルド時に自動で実行 |
| `app/src/main/assets/map.js` | 変換後の地図データ（自動生成。直接編集しない） |
| `app/src/main/assets/index.html` `app.css` `app.js` | 画面・位置推定・ルート探索・音声案内 |
| `app/src/main/java/jp/miminavi/app/MainActivity.java` | 画面（WebView）と端末機能の窓口。権限、読み上げ、音声認識、方位センサー |
| `app/src/main/java/jp/miminavi/app/BeaconScanner.java` | BLE スキャン。RSSI を直近4秒で平均し、0.5秒ごとに画面へ渡す |
| `app/src/main/java/jp/miminavi/app/BeaconParser.java` | 広告パケットの解析（iBeacon / AltBeacon / Eddystone-UID） |

外部ライブラリは使っていません（Android Gradle Plugin 9.4.1 / Gradle 9.6.0 / Java のみ）。

## iPhone（Beacon Simulator）の設定

- 形式：iBeacon
- UUID：全台同じ値（例：E2C56DB5-DFFB-48D2-B060-D0F5A71096E0）
- Major：全台 1
- **Minor：図面の B-xx の番号に合わせる**（B-01 の場所に置く iPhone は Minor 1、B-13 は Minor 13）
- iPhone は画面をつけたまま、アプリを前面に表示しておく（画面が消えると送信が止まります）

アプリは Minor 番号で図面のビーコンに自動で対応させます。番号が合わない場合は、「ビーコン」タブの各ビーコンにある「図面の位置」で B-xx を選ぶか、「図面をタップして場所を指定…」で好きな場所に置けます（手動の設定が優先。端末に保存されます）。

## 使い方

1. 「ビーコン」タブ：受信中の iPhone と、対応する B-xx・RSSI・推定距離を表示。iPhone から 1m 離れて「1mで補正」を押すと距離の精度が上がります
2. 「図面」タブ：推定した現在地（オレンジの点）、各ビーコンの受信状況、目的地を表示
3. 「案内」タブ →「この施設で案内を始める」→ 方角合わせ → 行き先を話す（または行き先ボタンを押す）
   - 「トイレ」のように候補が複数あるときは「男子トイレと女子トイレ、どちらですか？」と聞き返します
   - 曲がり角の手前・曲がるとき・ドアの手前・目的地の手前で読み上げます
   - 目的地から約 1.2m 以内（または目的地そばのビーコンに約 1m 以内）で「到着しました」
   - 現在地が分からないときや「デモ歩行」を押したときは、ルートを自動で歩く想定で進みます

`app/src/main/assets/index.html` は PC のブラウザでも開けます（受付付近に立っている想定の疑似ビーコンで動作）。

## フロアマップの更新方法

1. `map/floor.drawio` を draw.io（https://app.diagrams.net）で開いて編集する
2. GitHub のリポジトリで `map/floor.drawio` を上書きアップロードする（Add file → Upload files）
3. 自動でビルドが走り、数分後に APK が新しい地図で更新される

draw.io 側のルール（図形を選んで Ctrl+M の「データを編集」で設定）

| kind | 意味 | 補足 |
|---|---|---|
| `wall` / `glass` / `partition` | 壁（線） | 通れない |
| `door` / `opening` | ドア・開口（壁の隙間に置く四角） | 通れる。`access=staff` で関係者用ドア |
| `furniture` / `pillar` / `equipment` | 家具・柱・設備 | 通れない |
| `room` | 部屋・エリア | 名前の表示と建物の内側の判定に使う |
| `destination` | 目的地 | `label` が名前、`keywords` が呼び方（カンマ区切り） |
| `beacon` | ビーコン | `label` が B-xx、`minor` が iPhone の Minor |
| 「イス」レイヤーの図形 | イス | デスクに収納する前提で通れる扱い |

- 縮尺：`length_mm` を設定した壁（西の外壁 7,694mm・南の外壁 16,478mm）から、縦横それぞれ自動で補正します
- 手元で変換を確認する場合：`python3 tools/drawio_to_map.py map/floor.drawio app/src/main/assets/map.js`

## 位置推定とルートのしくみ（PoC 用の簡易版）

- 距離 = 10^((1m地点のRSSI − 受信RSSI) ÷ (10 × n))。n は「ビーコン」タブで調整（初期値 2.0）
- 近い順に最大4台を、距離の2乗の逆数で重み付けして平均し、前回の位置となめらかにつなぎます
- 図面を 0.2m のマスに分け、壁ぎわを避けつつ曲がる回数の少ない最短ルートを計算します（ダイクストラ法）

## Android Studio で動かす場合

社内ネットワークでは SSL 検査の影響で Gradle がビルドに必要な部品を取得できないため、上記の GitHub Actions でのビルドを使ってください。社外ネットワークなどで Android Studio を使う場合は、このフォルダを「Open」で開いて ▶ で実行できます。

## 既知の制約

- 案内中はアプリを前面に表示したまま使う前提です（画面消灯中のスキャンは未対応）
- 音声認識は端末の音声入力（Google など）を呼び出します。入っていない端末では行き先ボタンか文字入力を使ってください
- 読み上げは端末の日本語音声を使います
