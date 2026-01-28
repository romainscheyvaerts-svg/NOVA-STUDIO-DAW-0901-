@echo off
chcp 65001 >nul 2>&1
title Nova VST Host - Build
color 0E

echo.
echo ========================================
echo   NOVA VST HOST - BUILD SCRIPT
echo ========================================
echo.

cd /d "%~dp0"

echo [1/5] Verification de Visual Studio C++...

:: Check if we can find Visual Studio 
set "VS_FOUND=0"

:: Try VS 2022
if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" (
    set "VS_FOUND=1"
    set "VS_VERSION=2022"
    call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
)
if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" (
    set "VS_FOUND=1"
    set "VS_VERSION=2022"
    call "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
)
if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" (
    set "VS_FOUND=1"
    set "VS_VERSION=2022"
    call "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
)

:: Try VS 2019
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat" (
    set "VS_FOUND=1"
    set "VS_VERSION=2019"
    call "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
)

if "%VS_FOUND%"=="0" (
    echo.
    echo ========================================
    echo   ERREUR: Visual Studio non installe
    echo ========================================
    echo.
    echo Tu dois installer Visual Studio 2022:
    echo.
    echo   1. Va sur: https://visualstudio.microsoft.com/fr/downloads/
    echo   2. Telecharge "Visual Studio Community 2022" (gratuit)
    echo   3. Pendant l'installation, COCHE:
    echo      [X] Developpement Desktop en C++
    echo.
    echo Ensuite, relance ce script.
    echo.
    echo ========================================
    pause
    exit /b 1
)

echo     Visual Studio %VS_VERSION% detecte !

echo.
echo [2/5] Verification de CMake...

cmake --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ========================================
    echo   ERREUR: CMake non installe
    echo ========================================
    echo.
    echo Tu dois installer CMake:
    echo.
    echo   1. Va sur: https://cmake.org/download/
    echo   2. Telecharge le Windows x64 Installer
    echo   3. Pendant l'installation, COCHE:
    echo      [X] Add CMake to the system PATH
    echo.
    echo Ensuite, relance ce script.
    echo.
    echo ========================================
    pause
    exit /b 1
)

echo     CMake detecte !

echo.
echo [3/5] Verification de Git...

git --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ========================================
    echo   ERREUR: Git non installe
    echo ========================================
    echo.
    echo Tu dois installer Git:
    echo.
    echo   1. Va sur: https://git-scm.com/download/win
    echo   2. Telecharge et installe Git
    echo.
    echo Ensuite, relance ce script.
    echo.
    echo ========================================
    pause
    exit /b 1
)

echo     Git detecte !

echo.
echo [4/5] Telechargement de JUCE Framework...

if not exist "JUCE" (
    echo     Clonage de JUCE (cela peut prendre 1-2 minutes)...
    git clone --depth 1 https://github.com/juce-framework/JUCE.git
    if errorlevel 1 (
        echo.
        echo ERREUR: Impossible de telecharger JUCE
        pause
        exit /b 1
    )
) else (
    echo     JUCE deja present !
)

echo.
echo [5/5] Compilation du projet...

if not exist "build" mkdir build
cd build

echo     Configuration CMake...
cmake .. -G "Visual Studio 17 2022" -A x64 2>nul
if errorlevel 1 (
    echo     Essai avec Visual Studio 2019...
    cmake .. -G "Visual Studio 16 2019" -A x64
)

if errorlevel 1 (
    echo.
    echo ERREUR: Configuration CMake echouee
    pause
    exit /b 1
)

echo     Compilation (cela peut prendre 5-10 minutes)...
cmake --build . --config Release

if errorlevel 1 (
    echo.
    echo ERREUR: Compilation echouee
    pause
    exit /b 1
)

echo.
echo ========================================
echo   SUCCES ! NovaVSTHost.exe cree
echo ========================================
echo.

if exist "NovaVSTHost_artefacts\Release\NovaVSTHost.exe" (
    copy "NovaVSTHost_artefacts\Release\NovaVSTHost.exe" "..\NovaVSTHost.exe" >nul
    echo Le fichier est ici: %~dp0NovaVSTHost.exe
    echo.
    echo Double-clique sur NovaVSTHost.exe pour le lancer !
)

echo.
pause
