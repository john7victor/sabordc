# -*- mode: python ; coding: utf-8 -*-
"""Empacota o SABOR num diretorio autocontido (dist/SABOR).

onedir e nao onefile de proposito: onefile extrai tudo para o %TEMP% a cada
execucao (arranque lento) e e o formato que mais dispara falso positivo de
antivirus. Como um instalador vai distribuir isso de qualquer forma, o
diretorio e melhor em todos os aspectos.
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

ROOT = Path(SPECPATH).parent

datas = [
    (str(ROOT / "web"), "web"),
]
# pywebview carrega as DLLs do WebView2 dos proprios dados do pacote
datas += collect_data_files("webview")
datas += collect_data_files("clr_loader")

binaries = collect_dynamic_libs("clr_loader")
binaries += collect_dynamic_libs("pythonnet")

hiddenimports = [
    "clr",
    "clr_loader",
    # so os backends do Windows: puxar webview.platforms inteiro arrastaria
    # gtk/qt/cocoa, que nao existem aqui
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
]

a = Analysis(
    [str(ROOT / "run.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PIL", "PyInstaller",          # so usados no build
        "tkinter", "unittest", "pydoc", "doctest",
        "numpy", "matplotlib", "pytest",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SABOR",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "installer" / "sabor.ico"),
    version=str(ROOT / "installer" / "version_info.txt"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="SABOR",
)
