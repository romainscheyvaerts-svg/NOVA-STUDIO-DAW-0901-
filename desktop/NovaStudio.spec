# -*- mode: python ; coding: utf-8 -*-
# Recette PyInstaller de Nova Studio pour Windows (dossier dist/NovaStudio/, sans console).
# Lancée par build.py ; les sources des ponts viennent de ../bridge-python (non modifiées),
# l'interface du DAW de build/ui-bundle (build_ui.py).
import glob
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

datas = [
    ('offline.html', '.'),
    ('assets/nova.ico', '.'),
]
datas += [(f, 'webview2') for f in glob.glob('vendor/webview2/*.dll')]
# Interface du DAW embarquée (construite par build_ui.py) -> _internal/ui/
import os
if not os.path.isfile('build/ui-bundle/desktop-ui.json'):
    raise SystemExit("build/ui-bundle absent : lancer build.py (ou build_ui.py) d'abord")
datas += [('build/ui-bundle', 'ui')]
binaries = []
hiddenimports = ['asio_bridge', 'asio_control_panel', 'nova_bridge_server', 'vst_host', 'vst_probe', 'license_watch',
                 'comtypes', 'comtypes.client']
hiddenimports += collect_submodules('websockets')

# pont ASIO : PortAudio compilé avec ASIO (_sounddevice_data)
datas += collect_data_files('_sounddevice_data')
for pkg in ('sounddevice', 'pedalboard'):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hiddenimports += h
hiddenimports += ['pedalboard_native']

a = Analysis(
    ['nova_desktop.py'],
    pathex=['../bridge-python'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'pytest', 'IPython', 'pyaudio', 'pydoc', 'unittest'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='NovaStudio',
    icon='assets/nova.ico',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX abîme les .pyd natifs (pedalboard) et alerte les antivirus
    console=False,       # aucune fenêtre console, ni pour l'appli ni pour les ponts
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='NovaStudio',
)
