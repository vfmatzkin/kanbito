@echo off
REM Build Kanbito for Windows
REM Thin wrapper around the unified build.py script

cd /d "%~dp0.."
python scripts\build.py %*
pause
