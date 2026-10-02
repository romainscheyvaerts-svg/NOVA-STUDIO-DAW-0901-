@echo off
rem Construit Nova Studio pour Windows et son installateur (voir README.md).
rem Resultat : public\downloads\NovaStudioSetup.exe
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8

if not exist venv\Scripts\python.exe (
  echo Creation de l environnement Python desktop\venv...
  py -3 -m venv venv || python -m venv venv || goto :err
  venv\Scripts\python.exe -m pip install --upgrade pip || goto :err
)
venv\Scripts\python.exe -m pip install -q -r requirements.txt || goto :err
venv\Scripts\python.exe build.py %* || goto :err
echo.
echo Termine.
exit /b 0

:err
echo.
echo ECHEC de la construction.
exit /b 1
