# -*- mode: python ; coding: utf-8 -*-
# Recette PyInstaller du pont VST3 (NovaVSTBridge.exe, un seul fichier).
#
# Construction (Windows, depuis bridge-python/) :
#   venv\Scripts\python.exe -m pip install pyinstaller websockets numpy pedalboard
#   venv\Scripts\python.exe -m PyInstaller NovaVSTBridge.spec --noconfirm --workpath %TEMP%\nova-vst-build
# Résultat : dist\NovaVSTBridge.exe (dist/ et build/ ne sont pas versionnés).
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = collect_submodules('websockets')

# pedalboard embarque un module natif (JUCE) et ses données : on prend tout.
tmp_ret = collect_all('pedalboard')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
hiddenimports += ['pedalboard_native', 'vst_host', 'vst_probe', 'license_watch', 'stems_service', 'stems_install', 'vst_automation']
datas += [('stems_worker.py', '.')]  # séparation de stems : moteur lancé dans le module optionnel


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
    excludes=['tkinter', 'matplotlib', 'PIL', 'pytest', 'IPython', 'sounddevice'],
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
