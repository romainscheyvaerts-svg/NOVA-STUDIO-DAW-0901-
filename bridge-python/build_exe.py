#!/usr/bin/env python3
"""
Build script for Nova ASIO Bridge executable

Creates a standalone Windows EXE that can be distributed to users.
The EXE includes all Python dependencies and can run without Python installed.

Usage:
    python build_exe.py

Output:
    dist/NovaASIOBridge.exe
"""

import subprocess
import sys
import os
import shutil

def main():
    print("=" * 60)
    print("  NOVA ASIO BRIDGE - Build EXE")
    print("=" * 60)
    
    # Install all required dependencies first
    print("\n📦 Installing dependencies...")
    dependencies = [
        "pyinstaller",
        "websockets",
        "numpy",
        "sounddevice",
        "comtypes"
    ]
    
    for dep in dependencies:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", dep], 
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"  ✅ {dep}")
        except subprocess.CalledProcessError:
            print(f"  ⚠️ {dep} (may already be installed)")
    
    # Verify PyInstaller
    try:
        import PyInstaller
        print(f"\n✅ PyInstaller version: {PyInstaller.__version__}")
    except ImportError:
        print("❌ PyInstaller installation failed!")
        return 1
    
    # Get the directory of this script
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    
    # Clean previous builds
    for folder in ["build", "dist"]:
        if os.path.exists(folder):
            print(f"🧹 Cleaning {folder}/...")
            shutil.rmtree(folder)
    
    # PyInstaller command
    # --onefile: Single EXE file
    # --noconsole: No console window (for GUI apps) - but we want console for debugging
    # --name: Name of the EXE
    # --icon: Icon file (if available)
    # --add-data: Include additional files
    
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--console",  # Keep console for logs
        "--name", "NovaASIOBridge",
        "--clean",
        # Hidden imports that PyInstaller might miss
        "--hidden-import", "websockets",
        "--hidden-import", "numpy",
        "--hidden-import", "sounddevice",
        "--hidden-import", "comtypes",
        # Add the control panel script
        "--add-data", f"asio_control_panel.py{os.pathsep}.",
        # Main script
        "asio_bridge.py"
    ]
    
    print("\n📦 Building EXE...")
    print(f"   Command: {' '.join(cmd)}")
    print()
    
    try:
        subprocess.check_call(cmd)
        
        exe_path = os.path.join(script_dir, "dist", "NovaASIOBridge.exe")
        if os.path.exists(exe_path):
            size_mb = os.path.getsize(exe_path) / (1024 * 1024)
            print("\n" + "=" * 60)
            print("  ✅ BUILD SUCCESSFUL!")
            print("=" * 60)
            print(f"\n   Output: {exe_path}")
            print(f"   Size:   {size_mb:.1f} MB")
            print("\n   To test:")
            print(f"   > cd dist")
            print(f"   > NovaASIOBridge.exe")
            print()
        else:
            print("\n❌ Build failed - EXE not found")
            return 1
            
    except subprocess.CalledProcessError as e:
        print(f"\n❌ Build failed: {e}")
        return 1
    
    return 0


if __name__ == "__main__":
    sys.exit(main())