"""Main application: PyWebView + Flask integration."""
from __future__ import annotations

import argparse
import shutil
import sys
import threading
import socket
import os
from contextlib import closing
from pathlib import Path

import webview

# Handle imports for both dev (relative) and bundled (absolute) modes
try:
    from .server import app, ensure_dirs, ensure_board_exists
except ImportError:
    from kanbito.server import app, ensure_dirs, ensure_board_exists


# Global state for tray integration
_tray_icon = None
_force_quit = False
_window = None


class Api:
    """JavaScript API exposed to the webview."""

    def select_folder(self, current_path: str = None):
        """Open a folder picker dialog and return the selected path."""
        global _window
        if not _window:
            return None

        result = _window.create_file_dialog(
            webview.FOLDER_DIALOG,
            directory=current_path or str(Path.home() / 'Documents')
        )

        if result and len(result) > 0:
            return result[0]
        return None

    def save_data_dir(self, path: str):
        """Save the data directory to ~/.kanbito-config."""
        if not path:
            return False

        config_file = Path.home() / '.kanbito-config'
        try:
            config_file.write_text(path.strip())
            return True
        except Exception as e:
            print(f"Failed to save config: {e}")
            return False

    def check_folder(self, path: str):
        """Check if a folder exists and if it's empty.

        Returns:
            dict with 'exists', 'empty', 'is_git_repo' keys
        """
        if not path:
            return {"exists": False, "empty": True, "is_git_repo": False}

        target = Path(path).expanduser().resolve()

        if not target.exists():
            return {"exists": False, "empty": True, "is_git_repo": False}

        is_empty = not any(target.iterdir())
        is_git = (target / '.git').exists()

        return {"exists": True, "empty": is_empty, "is_git_repo": is_git}

    def clear_folder(self, path: str):
        """Clear all contents of a folder.

        Returns:
            dict with 'success' and optionally 'error' keys
        """
        import shutil

        if not path:
            return {"success": False, "error": "No path provided"}

        target = Path(path).expanduser().resolve()

        try:
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True, exist_ok=True)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}



def get_data_directory(custom_dir: str | None = None) -> str:
    """Get the Kanbito data directory. Creates it if it doesn't exist.

    Priority:
    1. --data-dir command line argument
    2. KANBITO_DATA_DIR environment variable
    3. ~/.kanbito-config (contains path to data dir)
    4. Default: ~/Documents/Kanbito

    Location on all platforms:
    - macOS: /Users/<user>/Documents/Kanbito
    - Windows: C:\\Users\\<user>\\Documents\\Kanbito
    - Linux: /home/<user>/Documents/Kanbito
    """
    # 1. Command line argument
    if custom_dir:
        data_dir = Path(custom_dir).expanduser().resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        return str(data_dir)

    # 2. Environment variable
    env_dir = os.environ.get('KANBITO_DATA_DIR')
    if env_dir:
        data_dir = Path(env_dir).expanduser().resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        return str(data_dir)

    # 3. Config file in home directory
    config_file = Path.home() / '.kanbito-config'
    if config_file.exists():
        try:
            config_dir = config_file.read_text().strip()
            if config_dir:
                data_dir = Path(config_dir).expanduser().resolve()
                data_dir.mkdir(parents=True, exist_ok=True)
                return str(data_dir)
        except Exception:
            pass

    # 4. Default location
    data_dir = Path.home() / 'Documents' / 'Kanbito'
    data_dir.mkdir(parents=True, exist_ok=True)
    return str(data_dir)


def get_icon_path() -> str | None:
    """Get the path to the app icon."""
    # When running from source
    source_icon = Path(__file__).parent / 'static' / 'logo.png'
    if source_icon.exists():
        return str(source_icon)

    # When running from PyInstaller bundle
    if getattr(sys, 'frozen', False):
        bundle_dir = Path(sys._MEIPASS)
        frozen_icon = bundle_dir / 'kanbito' / 'static' / 'logo.png'
        if frozen_icon.exists():
            return str(frozen_icon)

    return None


def reset_data():
    """Reset all Kanbito data to fresh start."""
    cwd = Path.cwd()

    files_to_delete = ['board.json', 'notes.json', '.kanbito.json']
    dirs_to_delete = ['tasks', 'notes', 'images']

    deleted = []

    for f in files_to_delete:
        path = cwd / f
        if path.exists():
            path.unlink()
            deleted.append(f)

    for d in dirs_to_delete:
        path = cwd / d
        if path.exists():
            shutil.rmtree(path)
            deleted.append(f"{d}/")

    if deleted:
        print(f"Deleted: {', '.join(deleted)}")
    else:
        print("Nothing to reset (already clean)")

    print("Kanbito reset complete.")


def find_free_port() -> int:
    """Find a free port to use."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(('127.0.0.1', 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


def start_server(port: int):
    """Start the Flask server."""
    # Suppress Flask's default logging
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    app.run(host='127.0.0.1', port=port, threaded=True, use_reloader=False)


def show_window_from_tray(icon, item):
    """Show window when clicking tray icon."""
    global _window
    if _window:
        _window.show()
        _window.restore()


def quit_from_tray(icon, item):
    """Quit the application from tray."""
    global _force_quit, _window, _tray_icon
    _force_quit = True
    if _tray_icon:
        _tray_icon.stop()
        _tray_icon = None
    if _window:
        _window.destroy()


def create_tray_icon():
    """Create system tray icon with menu."""
    global _tray_icon
    import platform

    try:
        from PIL import Image
        import pystray
    except ImportError:
        # pystray not available, skip tray icon
        return None

    icon_path = get_icon_path()
    if not icon_path:
        return None

    try:
        image = Image.open(icon_path)
        # Resize for tray (typically 64x64 or smaller)
        image = image.resize((64, 64), Image.Resampling.LANCZOS)
    except Exception:
        return None

    menu = pystray.Menu(
        pystray.MenuItem("Show Kanbito", show_window_from_tray, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit Kanbito", quit_from_tray)
    )

    _tray_icon = pystray.Icon("Kanbito", image, "Kanbito", menu)

    # On macOS, pystray needs special handling
    if platform.system() == 'Darwin':
        # Run in detached mode for macOS compatibility
        try:
            _tray_icon.run_detached()
        except Exception:
            # If run_detached fails, try threaded approach
            tray_thread = threading.Thread(target=_tray_icon.run, daemon=True)
            tray_thread.start()
    else:
        # Windows/Linux: run in background thread
        tray_thread = threading.Thread(target=_tray_icon.run, daemon=True)
        tray_thread.start()

    return _tray_icon


def on_closing():
    """Handle window close - minimize to tray instead of quitting."""
    global _tray_icon, _force_quit, _window

    # If force quit requested (from tray menu), allow close
    if _force_quit:
        return True

    # If tray icon is active, hide to tray instead of closing
    if _tray_icon:
        if _window:
            _window.hide()
        return False  # Prevent window destruction

    return True  # Allow normal close (no tray)


def on_minimized():
    """Handle window minimize - hide to tray."""
    global _tray_icon, _window

    if _tray_icon and _window:
        _window.hide()


def main():
    """Main entry point."""
    global _window
    import webbrowser

    # Parse command line arguments
    parser = argparse.ArgumentParser(description='Kanbito - Personal Kanban Board')
    parser.add_argument('--data-dir', type=str, metavar='PATH',
                        help='Custom data directory (default: ~/Documents/Kanbito)')
    parser.add_argument('--reset', action='store_true',
                        help='Reset all data (delete board, notes, settings)')
    parser.add_argument('--debug', action='store_true',
                        help='Enable debug mode (right-click to inspect)')
    parser.add_argument('--browser', action='store_true',
                        help='Open in browser instead of native window')
    parser.add_argument('--no-tray', action='store_true',
                        help='Disable system tray (close button will quit)')
    args = parser.parse_args()

    # Handle reset
    if args.reset:
        reset_data()
        return

    # Get data directory - use ~/Documents/Kanbito by default on all platforms
    # Can be customized via --data-dir, KANBITO_DATA_DIR env var, or ~/.kanbito-config
    data_dir = get_data_directory(args.data_dir)
    os.chdir(data_dir)
    print(f"Kanbito - Data directory: {data_dir}")

    # Ensure directories exist
    ensure_dirs()
    ensure_board_exists()

    # Find a free port
    port = find_free_port()
    url = f'http://127.0.0.1:{port}'

    print(f"Starting server on {url}")

    # Start Flask in background thread
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Give the server a moment to start
    import time
    time.sleep(0.3)

    # Browser mode - just open in default browser
    if args.browser:
        print(f"Opening in browser: {url}")
        webbrowser.open(url)
        print("Press Ctrl+C to stop the server...")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nKanbito closed.")
            sys.exit(0)

    # Create API for JavaScript
    api = Api()

    # Create native window
    _window = webview.create_window(
        'Kanbito',
        url,
        width=1200,
        height=800,
        min_size=(800, 600),
        text_select=True,
        js_api=api
    )

    # Set up tray and event handlers (unless disabled)
    # Note: System tray is disabled on macOS due to threading limitations
    # macOS uses the Dock instead, which provides similar functionality
    import platform
    use_tray = not args.no_tray and platform.system() != 'Darwin'

    if use_tray:
        def on_shown():
            create_tray_icon()

        _window.events.shown += on_shown
        _window.events.closing += on_closing
        _window.events.minimized += on_minimized

    # Start the webview event loop (debug=True enables right-click inspect)
    import platform as _platform

    # Prefer Edge (WebView2) on Windows to avoid pythonnet/winforms import issues.
    # Fall back to default if Edge is not available or startup fails.
    gui_choice = None
    if _platform.system() == 'Windows':
        gui_choice = 'edgechromium'

    try:
        webview.start(debug=args.debug, gui=gui_choice)
    except Exception as e:
        print(f"webview.start failed with {e}; falling back to default GUI")
        webview.start(debug=args.debug)

    # Clean up tray icon
    global _tray_icon
    if _tray_icon:
        _tray_icon.stop()

    print("Kanbito closed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
