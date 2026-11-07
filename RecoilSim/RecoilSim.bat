@echo off
title RecoilSim
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 run.py %*
) else (
    python run.py %*
)
if errorlevel 1 (
    echo.
    echo RecoilSim stopped with an error. If Python isn't installed, get it from https://www.python.org/downloads/
    pause
)
