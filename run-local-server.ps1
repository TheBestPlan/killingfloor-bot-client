# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 TheBestPlan

# Launch a LOCAL Killing Floor dedicated server for protocol validation/capture.
# Run it directly (the game exe is started by hand):
#     pwsh -File run-local-server.ps1
# or with a different map/port:
#     pwsh -File run-local-server.ps1 -Map KF-Bedlam -Port 7707
#
# Then in another terminal:
#     node phase1_relay.js --listen 7708 --server 127.0.0.1:7707     # capture a real client
#     node phase2_client.js --server 127.0.0.1:7707 --name Bot       # try our headless client
#
# Notes:
# - KF dedicated server uses an anonymous Steam game-server login; Steam client need
#   not be logged in, but Steam being installed/running helps. If it exits instantly,
#   start Steam first, or launch the "Killing Floor" listen server from the game menu
#   (Host Game) instead and point the relay/client at its port.
# - The server window is headless (no 3D); close it when done.

param(
  [string]$KFRoot = $env:KF_GAME_DIR,   # override; auto-detected below if empty
  [string]$Map    = "KF-BioticsLab",
  [int]   $Port   = 7707,
  [string]$Game   = "KFmod.KFGameType",
  [int]   $MaxPlayers = 6
)

# Auto-detect the KillingFloor install from common Steam locations (no hardcoded path).
if (-not $KFRoot) {
  foreach ($base in @("${env:ProgramFiles(x86)}\Steam", "${env:ProgramFiles}\Steam", "C:\Steam")) {
    $c = Join-Path $base "steamapps\common\KillingFloor"
    if (Test-Path (Join-Path $c "System\KillingFloor.exe")) { $KFRoot = $c; break }
  }
}
if (-not $KFRoot) { Write-Error "KillingFloor not found - pass -KFRoot or set KF_GAME_DIR"; exit 1 }

$exe = Join-Path $KFRoot "System\KillingFloor.exe"
if (-not (Test-Path $exe)) { Write-Error "KillingFloor.exe not found at $exe"; exit 1 }

$url = "$Map.rom?game=$Game?MaxPlayers=$MaxPlayers?bNoLateJoiners=False?Port=$Port"
$args = "$url -nohomedir -server"

Write-Host "Launching: $exe $args"
Write-Host "Game port (UDP): $Port    GameSpy query port: $($Port+10)"
Push-Location (Join-Path $KFRoot "System")
& $exe $url "-nohomedir" "-server"
Pop-Location
