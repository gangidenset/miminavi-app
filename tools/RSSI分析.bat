@echo off
rem ミミナビ RSSI 分析（tools\analyze_rssi.py を動かす）
rem  ・ダブルクリック          … 近くの「測定データ」フォルダの測定結果 CSV をすべて分析する
rem  ・CSV やフォルダをこの上にドラッグ＆ドロップ … それだけを分析する
rem  結果は、このフォルダと同じ階層の「分析結果」フォルダ（なければ作る）に「RSSI分析結果_日付-時刻.md」として保存する。
rem  画面には結論（アプリに使う A と n）だけを出す
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY goto nopython
if not exist "%~dp0analyze_rssi.py" goto noscript
%PY% "%~dp0analyze_rssi.py" %* --summary --out-dir "%~dp0..\分析結果"
if errorlevel 1 goto failed
echo.
pause
exit /b 0

:nopython
echo Python が見つかりません。
echo https://www.python.org/downloads/ から Python 3 を入れてください
echo （インストール画面で「Add python.exe to PATH」にチェックを入れる）。
pause
exit /b 1

:noscript
echo analyze_rssi.py が見つかりません。このファイルと同じフォルダに置いてください。
pause
exit /b 1

:failed
echo.
echo 分析できませんでした。上のメッセージを確認してください。
pause
exit /b 1
