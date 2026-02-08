#!/bin/bash
# Build Kanbito.app for macOS
# Thin wrapper around the unified build.py script

set -e
cd "$(dirname "$0")/.."
python3 scripts/build.py "$@"
