@echo off
rem Construit NovaVSTHost.exe (hote VST3 natif de Nova Studio, SANS JUCE) avec MSVC + CMake + Ninja.
rem Source attendue dans %NOVA_LIBS% (defaut : D:\1 WORK\CODE\_libs\ara-host-sources) :
rem   vst3sdk  (Steinberg, MIT)  git clone --depth 1 --branch v3.8.1_build_84 https://github.com/steinbergmedia/vst3sdk.git
rem                              puis : git -C vst3sdk submodule update --init --depth 1 -- base cmake pluginterfaces public.sdk
rem Resultat : native-host\build\NovaVSTHost_artefacts\Release\NovaVSTHost.exe
setlocal
cd /d "%~dp0"
set VSLANG=1033
if "%NOVA_LIBS%"=="" set "NOVA_LIBS=D:/1 WORK/CODE/_libs/ara-host-sources"
if not exist "%NOVA_LIBS%\vst3sdk\pluginterfaces\base\funknown.h" (
  echo VST3 SDK introuvable dans %NOVA_LIBS%\vst3sdk
  echo   git clone --depth 1 --branch v3.8.1_build_84 https://github.com/steinbergmedia/vst3sdk.git "%NOVA_LIBS%\vst3sdk"
  echo   git -C "%NOVA_LIBS%\vst3sdk" submodule update --init --depth 1 -- base cmake pluginterfaces public.sdk
  exit /b 2
)
set "VSW=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
rem (variable absente quand le script est lance depuis Git Bash)
if not exist "%VSW%" set "VSW=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSW%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if "%VSDIR%"=="" (
  echo Visual Studio C++ introuvable
  exit /b 2
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DNOVA_LIBS=%NOVA_LIBS%" || exit /b 1
cmake --build build --config Release || exit /b 1
echo Construit : %~dp0build\NovaVSTHost_artefacts\Release\NovaVSTHost.exe
exit /b 0
