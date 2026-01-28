@echo off
title Nova Bridge VST3
color 0A
cd /d "%~dp0"

echo.
echo ========================================
echo   NOVA BRIDGE VST3 SERVER
echo ========================================
echo.

:: Verify Python
python --version
if errorlevel 1 (
    echo.
    echo ERREUR: Python non installe!
    echo Installez Python depuis python.org
    echo.
    pause
    exit /b 1
)

echo.
echo Installation des dependances...
pip install websockets numpy pedalboard 2>nul
pip install pillow pywin32 2>nul

echo.
echo ========================================
echo   Demarrage du serveur...
echo   Gardez cette fenetre OUVERTE
echo   Appuyez sur Ctrl+C pour arreter
echo ========================================
echo.

python nova_bridge_server.py

echo.
echo ========================================
echo   Le serveur s'est arrete
echo ========================================
echo.
pause
