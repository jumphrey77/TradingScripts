@echo off
cd /d %~dp0
echo Starting Finviz News Scanner...
echo.
python finviz_scanner.py
pause
