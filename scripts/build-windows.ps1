# Build Kanbito for Windows
# Thin wrapper around the unified build.py script
# Run with: powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1

$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot\..
try {
    python scripts/build.py @args
} finally {
    Pop-Location
}
