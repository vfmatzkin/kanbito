#!/usr/bin/env python3
"""Unified cross-platform build script for Kanbito.

Usage:
    python scripts/build.py              # Build only
    python scripts/build.py --package    # Build and create distributable
    python scripts/build.py --skip-deps  # Skip dependency installation

Requires: pyinstaller, pywebview, flask, pystray, pillow
Install with: pip install pyinstaller pywebview flask pystray pillow
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Build configuration
ENTRY_POINT = "src/kanbito/entry.py"
STATIC_DATA = "src/kanbito/static"
SOURCE_PATH = "src"

PLATFORM_CONFIG = {
    "Darwin": {
        "name": "Kanbito",
        "icon": "assets/kanbito.icns",
        "executable": "Kanbito.app",
    },
    "Linux": {
        "name": "kanbito",
        "icon": None,
        "executable": "kanbito/kanbito",
    },
    "Windows": {
        "name": "Kanbito",
        "icon": "assets/kanbito.ico",
        "executable": "Kanbito/Kanbito.exe",
    },
}

DEPENDENCIES = ["pyinstaller", "pywebview", "flask", "pystray", "pillow"]


def get_project_root() -> Path:
    """Get the project root directory."""
    # Script is in scripts/, so parent is project root
    return Path(__file__).parent.parent.resolve()


def run_command(cmd: list[str], cwd: Path | None = None) -> None:
    """Run a command and exit on failure."""
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}")
        sys.exit(result.returncode)


def install_dependencies() -> None:
    """Install Python dependencies using pip."""
    print("Installing dependencies...")
    run_command([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
    run_command([sys.executable, "-m", "pip", "install"] + DEPENDENCIES)


def build(project_root: Path, system: str) -> None:
    """Build the application using PyInstaller."""
    config = PLATFORM_CONFIG[system]

    # Pre-cleanup: try to remove previous dist output to avoid locked files on Windows.
    dist_target = project_root / "dist" / config["name"]
    if dist_target.exists():
        import time as _time
        # On Windows, attempt to kill a running Kanbito.exe which commonly locks the file
        if system == "Windows":
            try:
                exe_name = f"{config['name']}.exe"
                # Try taskkill to force-stop any running instance
                subprocess.run(["taskkill", "/F", "/IM", exe_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass

        # Retry removal a few times (handles transient locks / antivirus scans)
        for attempt in range(5):
            try:
                if dist_target.exists():
                    shutil.rmtree(dist_target)
                break
            except Exception as e:
                if attempt == 4:
                    print(f"Warning: Failed to remove {dist_target}: {e}")
                    print("Ensure no running Kanbito instances or other apps are holding files in the dist folder.")
                else:
                    _time.sleep(0.5)

    # Determine path separator for --add-data (semicolon on Windows, colon elsewhere)
    sep = ";" if system == "Windows" else ":"
    add_data = f"{STATIC_DATA}{sep}kanbito/static"

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconsole",
        "--onedir",
        "--name", config["name"],
        "--add-data", add_data,
        "--paths", SOURCE_PATH,
        "--noconfirm",
        ENTRY_POINT,
    ]

    # Add icon if available
    if config["icon"]:
        icon_path = project_root / config["icon"]
        if icon_path.exists():
            cmd.extend(["--icon", str(icon_path)])
        else:
            print(f"Warning: Icon not found at {icon_path}")

    print(f"Building {config['name']} for {system}...")
    run_command(cmd, cwd=project_root)

    # Make executable on Linux
    if system == "Linux":
        executable = project_root / "dist" / config["executable"]
        if executable.exists():
            executable.chmod(0o755)

    print(f"\nBuild complete! Output: dist/{config['executable']}")


def package_darwin(project_root: Path) -> Path:
    """Create macOS DMG with Applications symlink."""
    print("Creating macOS DMG...")

    dist_dir = project_root / "dist"
    app_bundle = dist_dir / "Kanbito.app"
    dmg_path = dist_dir / "Kanbito-macOS.dmg"

    # Create a temporary folder for DMG contents
    dmg_contents = dist_dir / "dmg_contents"
    if dmg_contents.exists():
        shutil.rmtree(dmg_contents)
    dmg_contents.mkdir()

    # Copy app to DMG contents
    shutil.copytree(app_bundle, dmg_contents / "Kanbito.app", symlinks=True)

    # Create symlink to Applications folder
    (dmg_contents / "Applications").symlink_to("/Applications")

    # Remove existing DMG if present
    if dmg_path.exists():
        dmg_path.unlink()

    # Create DMG from the folder
    run_command([
        "hdiutil", "create",
        "-volname", "Kanbito",
        "-srcfolder", str(dmg_contents),
        "-ov", "-format", "UDZO",
        str(dmg_path)
    ], cwd=project_root)

    # Clean up
    shutil.rmtree(dmg_contents)

    print(f"Created: {dmg_path}")
    return dmg_path


def package_linux(project_root: Path) -> Path:
    """Create Linux tar.gz archive."""
    print("Creating Linux tar.gz...")

    dist_dir = project_root / "dist"
    source_dir = dist_dir / "kanbito"
    archive_name = "Kanbito-Linux.tar.gz"
    archive_path = dist_dir / archive_name

    # Remove existing archive if present
    if archive_path.exists():
        archive_path.unlink()

    # Create tar.gz
    run_command([
        "tar", "-czvf", archive_name, "kanbito"
    ], cwd=dist_dir)

    print(f"Created: {archive_path}")
    return archive_path


def package_windows(project_root: Path) -> Path:
    """Create Windows ZIP archive."""
    print("Creating Windows ZIP...")

    dist_dir = project_root / "dist"
    source_dir = dist_dir / "Kanbito"
    archive_path = dist_dir / "Kanbito-Windows"

    # Remove existing archive if present
    if Path(str(archive_path) + ".zip").exists():
        Path(str(archive_path) + ".zip").unlink()

    # Create ZIP using shutil (cross-platform)
    shutil.make_archive(str(archive_path), "zip", dist_dir, "Kanbito")

    final_path = Path(str(archive_path) + ".zip")
    print(f"Created: {final_path}")
    return final_path


def package(project_root: Path, system: str) -> Path | None:
    """Create platform-specific distributable package."""
    if system == "Darwin":
        return package_darwin(project_root)
    elif system == "Linux":
        return package_linux(project_root)
    elif system == "Windows":
        return package_windows(project_root)
    else:
        print(f"Packaging not implemented for {system}")
        return None


def print_usage(system: str) -> None:
    """Print platform-specific usage instructions."""
    config = PLATFORM_CONFIG[system]

    print("\n" + "=" * 50)
    print("Build completed successfully!")
    print("=" * 50)

    if system == "Darwin":
        print("\nRun with:")
        print("  open dist/Kanbito.app")
        print("\nOr copy to Applications:")
        print("  cp -r dist/Kanbito.app /Applications/")
    elif system == "Linux":
        print("\nRun with:")
        print("  ./dist/kanbito/kanbito")
        print("\nOr install to /opt:")
        print("  sudo cp -r dist/kanbito /opt/")
        print("  sudo ln -sf /opt/kanbito/kanbito /usr/local/bin/kanbito")
    elif system == "Windows":
        print("\nRun with:")
        print("  .\\dist\\Kanbito\\Kanbito.exe")
        print("\nOr create a shortcut to Kanbito.exe on your Desktop")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build Kanbito for the current platform"
    )
    parser.add_argument(
        "--package",
        action="store_true",
        help="Create distributable package (DMG/tar.gz/ZIP)"
    )
    parser.add_argument(
        "--skip-deps",
        action="store_true",
        help="Skip dependency installation"
    )
    args = parser.parse_args()

    system = platform.system()
    if system not in PLATFORM_CONFIG:
        print(f"Unsupported platform: {system}")
        sys.exit(1)

    project_root = get_project_root()
    os.chdir(project_root)

    print(f"Building Kanbito for {system}")
    print(f"Project root: {project_root}")
    print()

    # Install dependencies if needed
    if not args.skip_deps:
        install_dependencies()

    # Build
    build(project_root, system)

    # Package if requested
    if args.package:
        package(project_root, system)

    # Print usage
    print_usage(system)


if __name__ == "__main__":
    main()
