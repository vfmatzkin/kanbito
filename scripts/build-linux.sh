#!/bin/bash
# Build Kanbito for Linux
# Thin wrapper around the unified build.py script

set -e
cd "$(dirname "$0")/.."

# Check for required system dependencies
if ! pkg-config --exists gtk+-3.0 2>/dev/null; then
    echo ""
    echo "Missing GTK3. Install with:"
    echo "  Ubuntu/Debian: sudo apt-get install libgtk-3-dev"
    echo "  Fedora: sudo dnf install gtk3-devel"
    echo "  Arch: sudo pacman -S gtk3"
    echo ""
fi

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null && ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    echo ""
    echo "Missing WebKit2GTK. Install with:"
    echo "  Ubuntu 24.04+: sudo apt-get install libwebkit2gtk-4.1-dev"
    echo "  Ubuntu 22.04:  sudo apt-get install libwebkit2gtk-4.0-dev"
    echo "  Fedora: sudo dnf install webkit2gtk3-devel"
    echo "  Arch: sudo pacman -S webkit2gtk"
    echo ""
fi

python3 scripts/build.py "$@"
