@echo off
REM ╔══════════════════════════════════════════════════════════════════════════════╗
REM ║                    NOVA ASIO BRIDGE - Audio Interface Bridge                 ║
REM ║                                                                              ║
REM ║  Démarre le serveur ASIO Bridge pour connecter le DAW web                    ║
REM ║  à une carte son ASIO sur Windows                                            ║
REM ╚══════════════════════════════════════════════════════════════════════════════╝

echo.
echo ============================================================
echo   NOVA ASIO BRIDGE - Audio Interface Bridge
echo ============================================================
echo.

REM Vérifier si Python est installé
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python n'est pas installe ou pas dans le PATH
    echo Installez Python depuis https://www.python.org/downloads/
    pause
    exit /b 1
)

REM Aller dans le dossier du script
cd /d "%~dp0"

REM Vérifier si les dépendances sont installées
echo [INFO] Verification des dependances...
python -c "import sounddevice" >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installation des dependances...
    pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERREUR] Echec de l'installation des dependances
        pause
        exit /b 1
    )
)

echo.
echo [INFO] Demarrage du serveur ASIO Bridge sur le port 8766...
echo [INFO] Connectez le DAW web a ws://127.0.0.1:8766
echo.
echo [CTRL+C pour arreter le serveur]
echo.

REM Démarrer le serveur ASIO Bridge
python asio_bridge.py

pause