@echo off
echo ============================================
echo   Nova ASIO Bridge - Build EXE
echo ============================================
echo.

:: Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    pause
    exit /b 1
)

:: Run the build script
python build_exe.py

echo.
pause