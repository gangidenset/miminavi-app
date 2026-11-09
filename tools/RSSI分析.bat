@echo off
rem ミミナビ RSSI 分析（tools\analyze_rssi.py を動かす）
rem  ・ダブルクリック          … 近くの「測定データ」フォルダの測定結果 CSV をすべて分析する
rem  ・CSV やフォルダをこの上にドラッグ＆ドロップ … それだけを分析する
rem  結果はこのファイルと同じフォルダの「RSSI分析結果.md」に保存し、メモ帳で開く
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY goto nopython
if not exist "%~dp0analyze_rssi.py" goto noscript
set "OUT=%~dp0RSSI分析結果.md"
%PY% "%~dp0analyze_rssi.py" %* --out "%OUT%" >nul
if errorlevel 1 goto failed
echo 分析が終わりました：%OUT%
start "" notepad "%OUT%"
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
