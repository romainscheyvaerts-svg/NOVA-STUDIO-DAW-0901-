@echo off
rem Construit NovaARAHost.exe (hote ARA2 de Nova Studio, SANS JUCE) avec MSVC + CMake + Ninja.
rem Sources attendues dans %NOVA_LIBS% (defaut : D:\1 WORK\CODE\_libs\ara-host-sources) :
rem   vst3sdk  (Steinberg, MIT)      git clone --depth 1 --branch v3.8.1_build_84 https://github.com/steinbergmedia/vst3sdk.git
rem                                  puis : git -C vst3sdk submodule update --init --depth 1 -- base cmake pluginterfaces public.sdk
rem   ARA_SDK  (Celemony, Apache 2)  git clone --depth 1 --recurse-submodules https://github.com/Celemony/ARA_SDK.git
rem Resultat : nova-ara-host\build\NovaARAHost_artefacts\Release\NovaARAHost.exe
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
if not exist "%NOVA_LIBS%\ARA_SDK\ARA_API\ARAInterface.h" (
  echo ARA SDK introuvable dans %NOVA_LIBS%\ARA_SDK
  echo   git clone --depth 1 --recurse-submodules https://github.com/Celemony/ARA_SDK.git "%NOVA_LIBS%\ARA_SDK"
  exit /b 2
)
set "VSW=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSW%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if "%VSDIR%"=="" (
  echo Visual Studio C++ introuvable
  exit /b 2
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DNOVA_LIBS=%NOVA_LIBS%" || exit /b 1
cmake --build build --config Release || exit /b 1
echo Construit : %~dp0build\NovaARAHost_artefacts\Release\NovaARAHost.exe
exit /b 0
