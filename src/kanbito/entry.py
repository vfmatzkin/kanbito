"""Entry point for PyInstaller builds."""
import sys
import os

# When running from PyInstaller bundle, add the bundle path to sys.path
if getattr(sys, 'frozen', False):
    bundle_dir = sys._MEIPASS
    sys.path.insert(0, bundle_dir)

# Now import and run
from kanbito.app import main

if __name__ == "__main__":
    main()
