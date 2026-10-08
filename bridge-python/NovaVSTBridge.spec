# -*- mode: python ; coding: utf-8 -*-
# Recette PyInstaller du pont VST3 (NovaVSTBridge.exe, un seul fichier).
#
# Construction (Windows, depuis bridge-python/) :
#   venv\Scripts\python.exe -m pip install pyinstaller websockets numpy
#   (moteur VST : NovaVSTHost.exe, construit par ../native-host/build.bat ; pedalboard n'est plus livré)
#   venv\Scripts\python.exe -m PyInstaller NovaVSTBridge.spec --noconfirm --workpath %TEMP%\nova-vst-build
# Résultat : dist\NovaVSTBridge.exe (dist/ et build/ ne sont pas versionnés).
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = collect_submodules('websockets')

hiddenimports += ['vst_host', 'vst_probe', 'license_watch', 'stems_service', 'stems_install', 'vst_automation', 'vst_sidechain']
datas += [('stems_worker.py', '.')]  # séparation de stems : moteur lancé dans le module optionnel
# Hôte VST3 natif (moteur par défaut, MIT, sans JUCE) : voir ../native-host/LICENCES.md
import glob, os
hiddenimports += ['vst_native', 'nova_vst3host']
if os.path.isfile('../native-host/build/NovaVSTHost_artefacts/Release/NovaVSTHost.exe'):
    binaries += [('../native-host/build/NovaVSTHost_artefacts/Release/NovaVSTHost.exe', '.')]
    datas += [('../native-host/LICENCES.md', 'vst-host')]
    datas += [(f, 'vst-host/licences') for f in glob.glob('../native-host/licences/*.txt')]


a = Analysis(
    ['nova_bridge_server.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Inutiles au pont : on allège l'exécutable.
    excludes=['pedalboard', 'pedalboard_native', 'vst_shell'] + ['tkinter', 'matplotlib', 'PIL', 'pytest', 'IPython', 'sounddevice'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='NovaVSTBridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX corrompt parfois les .pyd natifs de pedalboard
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,       # la fenêtre console sert de témoin « pont lancé »
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
