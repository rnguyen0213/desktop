# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

<#
.SYNOPSIS
Removes what Zen leaves behind after it's uninstalled.

.DESCRIPTION
Run it after uninstalling Zen (Settings > Apps > Installed apps). For the
current user it removes:
  - Zen's profiles and cache: %APPDATA%\zen and %LOCALAPPDATA%\zen, with all
    bookmarks, history, passwords and settings
  - %APPDATA%\Mozilla\Zen and %LOCALAPPDATA%\Mozilla\Zen
  - Zen's registry key, HKCU\Software\Mozilla\Zen
  - what each Zen install left under its install hash: update data in
    ProgramData, notification registrations and settings, browser
    registrations, scheduled tasks
  - shortcuts to Zen's install folder, and what's left of that folder

Zen's installer uses Firefox's names, so Zen and Firefox share some places.
There, only entries tied to a Zen install folder or hash are removed; Firefox
and its data are left alone.

It lists what it found and asks before deleting anything. -WhatIf only lists.

.PARAMETER InstallDir
Zen's install folders. By default C:\Program Files\Zen Browser and
%LOCALAPPDATA%\Zen Browser, plus any folder named in Zen's registry key.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File Remove-ZenLeftovers.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string[]]$InstallDir
)

$ErrorActionPreference = 'Stop'

# Firefox names per-install data after a hash of the install folder: the
# CityHash64 (v1.0.3) of its UTF-16 path, in upper case hex. See
# GetInstallHash() in toolkit/mozapps/update/common/commonupdatedir.cpp.
Add-Type -TypeDefinition @'
using System;

public static class ZenCityHash {
  const ulong K0 = 0xc3a5c85c97cb3127UL;
  const ulong K1 = 0xb492b66fbe98f273UL;
  const ulong K2 = 0x9ae16a3b2f90404fUL;
  const ulong K3 = 0xc949d7c7509e6557UL;

  static ulong Load64(byte[] s, int i) { return BitConverter.ToUInt64(s, i); }
  static ulong Load32(byte[] s, int i) { return BitConverter.ToUInt32(s, i); }
  static ulong Rotate(ulong v, int shift) { return shift == 0 ? v : (v >> shift) | (v << (64 - shift)); }
  static ulong RotateByAtLeast1(ulong v, int shift) { return (v >> shift) | (v << (64 - shift)); }
  static ulong ShiftMix(ulong v) { return v ^ (v >> 47); }

  static ulong HashLen16(ulong u, ulong v) {
    const ulong kMul = 0x9ddfea08eb382d69UL;
    ulong a = (u ^ v) * kMul;
    a ^= a >> 47;
    ulong b = (v ^ a) * kMul;
    b ^= b >> 47;
    return b * kMul;
  }

  static ulong HashLen0to16(byte[] s, int len) {
    if (len > 8) {
      ulong a = Load64(s, 0);
      ulong b = Load64(s, len - 8);
      return HashLen16(a, RotateByAtLeast1(b + (ulong)len, len)) ^ b;
    }
    if (len >= 4) {
      ulong a = Load32(s, 0);
      return HashLen16((ulong)len + (a << 3), Load32(s, len - 4));
    }
    if (len > 0) {
      uint y = s[0] + ((uint)s[len >> 1] << 8);
      uint z = (uint)len + ((uint)s[len - 1] << 2);
      return ShiftMix(y * K2 ^ z * K3) * K2;
    }
    return K2;
  }

  static ulong HashLen17to32(byte[] s, int len) {
    ulong a = Load64(s, 0) * K1;
    ulong b = Load64(s, 8);
    ulong c = Load64(s, len - 8) * K2;
    ulong d = Load64(s, len - 16) * K0;
    return HashLen16(Rotate(a - b, 43) + Rotate(c, 30) + d,
                     a + Rotate(b ^ K3, 20) - c + (ulong)len);
  }

  static void WeakHashLen32WithSeeds(byte[] s, int i, ulong a, ulong b, out ulong first, out ulong second) {
    ulong w = Load64(s, i), x = Load64(s, i + 8), y = Load64(s, i + 16), z = Load64(s, i + 24);
    a += w;
    b = Rotate(b + a + z, 21);
    ulong c = a;
    a += x;
    a += y;
    b += Rotate(a, 44);
    first = a + z;
    second = b + c;
  }

  static ulong HashLen33to64(byte[] s, int len) {
    ulong z = Load64(s, 24);
    ulong a = Load64(s, 0) + ((ulong)len + Load64(s, len - 16)) * K0;
    ulong b = Rotate(a + z, 52);
    ulong c = Rotate(a, 37);
    a += Load64(s, 8);
    c += Rotate(a, 7);
    a += Load64(s, 16);
    ulong vf = a + z;
    ulong vs = b + Rotate(a, 31) + c;
    a = Load64(s, 16) + Load64(s, len - 32);
    z = Load64(s, len - 8);
    b = Rotate(a + z, 52);
    c = Rotate(a, 37);
    a += Load64(s, len - 24);
    c += Rotate(a, 7);
    a += Load64(s, len - 16);
    ulong wf = a + z;
    ulong ws = b + Rotate(a, 31) + c;
    ulong r = ShiftMix((vf + ws) * K2 + (wf + vs) * K0);
    return ShiftMix(r * K0 + vs) * K2;
  }

  public static ulong Hash64(byte[] s) {
    int len = s.Length;
    if (len <= 32) {
      return len <= 16 ? HashLen0to16(s, len) : HashLen17to32(s, len);
    }
    if (len <= 64) {
      return HashLen33to64(s, len);
    }
    ulong x = Load64(s, 0);
    ulong y = Load64(s, len - 16) ^ K1;
    ulong z = Load64(s, len - 56) ^ K0;
    ulong v1, v2, w1, w2;
    WeakHashLen32WithSeeds(s, len - 64, (ulong)len, y, out v1, out v2);
    WeakHashLen32WithSeeds(s, len - 32, (ulong)len * K1, K0, out w1, out w2);
    z += ShiftMix(v2) * K1;
    x = Rotate(z + x, 39) * K1;
    y = Rotate(y, 33) * K1;
    int remaining = (len - 1) & ~63;
    int i = 0;
    do {
      x = Rotate(x + y + v1 + Load64(s, i + 16), 37) * K1;
      y = Rotate(y + v2 + Load64(s, i + 48), 42) * K1;
      x ^= w2;
      y ^= v1;
      z = Rotate(z ^ w1, 33);
      WeakHashLen32WithSeeds(s, i, v2 * K1, x + w1, out v1, out v2);
      WeakHashLen32WithSeeds(s, i + 32, z + w2, y, out w1, out w2);
      ulong t = z; z = x; x = t;
      i += 64;
      remaining -= 64;
    } while (remaining != 0);
    return HashLen16(HashLen16(v1, w1) + ShiftMix(y) * K1 + z,
                     HashLen16(v2, w2) + x);
  }
}
'@

function Get-InstallHash([string]$Dir) {
  [ZenCityHash]::Hash64([Text.Encoding]::Unicode.GetBytes($Dir)).ToString('X')
}

# ---- Refuse while Zen is installed or running --------------------------------

$uninstallRoots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
$installed = foreach ($root in $uninstallRoots) {
  if (Test-Path $root) {
    Get-ChildItem $root | ForEach-Object { $_.GetValue('DisplayName') } | Where-Object { $_ -like 'Zen Browser*' }
  }
}
if ($installed) {
  Write-Host "Zen is still installed ($(@($installed)[0])). Uninstall it first in Settings > Apps > Installed apps."
  exit 1
}
if (Get-Process zen -ErrorAction SilentlyContinue) {
  Write-Host 'Zen is running. Close it, then run this again.'
  exit 1
}

# ---- Find Zen's install folders and hashes ------------------------------------

$zenKey = 'HKCU:\Software\Mozilla\Zen'
$dirs = New-Object System.Collections.Generic.List[string]
function Add-Dir([string]$Dir) {
  $Dir = $Dir.TrimEnd('\')
  if ($Dir -match '^[A-Za-z]:\\' -and -not ($dirs -contains $Dir)) { $dirs.Add($Dir) }
}
if ($InstallDir) {
  $InstallDir | ForEach-Object { Add-Dir $_ }
} else {
  Add-Dir "$env:ProgramFiles\Zen Browser"
  Add-Dir "$env:LOCALAPPDATA\Zen Browser"
}
# Zen keys some values by its path, e.g. "C:\Program Files\Zen Browser\zen.exe|Image".
if (Test-Path $zenKey) {
  foreach ($key in @(Get-Item $zenKey) + @(Get-ChildItem $zenKey -Recurse)) {
    foreach ($name in $key.GetValueNames()) {
      $path = ($name -split '\|')[0]
      if ($path -like '*.exe') { $path = Split-Path $path }
      Add-Dir $path
    }
  }
}

$hashes = New-Object System.Collections.Generic.List[string]
function Add-Hash([string]$Hash) {
  if ($Hash -match '^[0-9A-F]{1,16}$' -and -not ($hashes -contains $Hash)) { $hashes.Add($Hash.ToUpper()) }
}
$dirs | ForEach-Object { Add-Hash (Get-InstallHash $_) }
# Every install that used a Zen profile: [<hash>] in installs.ini, [Install<hash>] in profiles.ini.
foreach ($ini in "$env:APPDATA\zen\installs.ini", "$env:APPDATA\zen\profiles.ini") {
  if (Test-Path $ini) {
    Get-Content $ini | ForEach-Object { if ($_ -match '^\[(?:Install)?([0-9A-Fa-f]{1,16})\]$') { Add-Hash $Matches[1].ToUpper() } }
  }
}
if (Test-Path "$zenKey\Installer") { Get-ChildItem "$zenKey\Installer" | ForEach-Object { Add-Hash $_.PSChildName } }

# ---- Collect what's left ---------------------------------------------------------

$items = New-Object System.Collections.Generic.List[object]
function Add-Item([string]$Kind, [string]$Path, [string]$Value) {
  $items.Add([pscustomobject]@{ Kind = $Kind; Path = $Path; Value = $Value })
}

# Files and folders.
# Mozilla\Zen holds the launcher's DLL blocklist and crash data; Mozilla\Firefox
# next to it is Firefox's and stays.
foreach ($path in "$env:APPDATA\zen", "$env:LOCALAPPDATA\zen", "$env:APPDATA\Mozilla\Zen", "$env:LOCALAPPDATA\Mozilla\Zen") {
  if (Test-Path $path) { Add-Item 'Folder' $path }
}
foreach ($dir in $dirs) {
  if (Test-Path $dir) { Add-Item 'Folder' $dir }
}
$updateRoot = Join-Path $env:ProgramData 'Mozilla-1de4eec8-1241-4177-a864-e594e8d1fb38'
foreach ($hash in $hashes) {
  foreach ($path in "$updateRoot\updates\$hash", "$updateRoot\UpdateLock-$hash") {
    if (Test-Path $path) { Add-Item 'Folder' $path }
  }
}

# Shortcuts to a Zen install folder.
$shell = New-Object -ComObject WScript.Shell
$linkFolders = @(
  [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'),
  [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),
  "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
foreach ($folder in $linkFolders) {
  if (-not $folder -or -not (Test-Path $folder)) { continue }
  foreach ($link in Get-ChildItem $folder -Filter *.lnk -Recurse -ErrorAction SilentlyContinue) {
    $target = $shell.CreateShortcut($link.FullName).TargetPath
    foreach ($dir in $dirs) {
      if ($target -like "$dir\*") { Add-Item 'Shortcut' $link.FullName; break }
    }
  }
}

# Registry: Zen's own key.
if (Test-Path $zenKey) { Add-Item 'Key' $zenKey }

# Registry: values Zen's installer wrote under Firefox's key, named after Zen's folder.
$firefoxKey = 'HKCU:\Software\Mozilla\Firefox'
if (Test-Path $firefoxKey) {
  foreach ($key in @(Get-Item $firefoxKey) + @(Get-ChildItem $firefoxKey -Recurse)) {
    foreach ($name in $key.GetValueNames()) {
      foreach ($dir in $dirs) {
        if ($name -eq $dir -or $name -like "$dir\*" -or $name -like "$dir|*") {
          Add-Item 'Value' $key.PSPath $name; break
        }
      }
    }
  }
}

# Registry: per-install entries named after a Zen install hash.
$classes = 'HKCU:\Software\Classes'
foreach ($hash in $hashes) {
  $aumid = "ZenToast-$hash"
  $activator = $null
  if (Test-Path "$classes\AppUserModelId\$aumid") {
    $activator = (Get-Item "$classes\AppUserModelId\$aumid").GetValue('CustomActivator')
    Add-Item 'Key' "$classes\AppUserModelId\$aumid"
  }
  if ($activator -match '^\{[0-9A-Fa-f-]{36}\}$') {
    foreach ($path in "$classes\CLSID\$activator", "$classes\AppID\$activator") {
      if (Test-Path $path) { Add-Item 'Key' $path }
    }
  }
  $notifications = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
  foreach ($name in $aumid, $hash) {
    if (Test-Path "$notifications\$name") { Add-Item 'Key' "$notifications\$name" }
  }
  if (Test-Path $classes) {
    Get-ChildItem $classes | Where-Object { $_.PSChildName -match "^Firefox[A-Za-z]*-$hash$" } |
      ForEach-Object { Add-Item 'Key' $_.PSPath }
  }
  $client = "HKCU:\Software\Clients\StartMenuInternet\Firefox-$hash"
  if (Test-Path $client) { Add-Item 'Key' $client }
  $registered = 'HKCU:\Software\RegisteredApplications'
  if ((Test-Path $registered) -and ((Get-Item $registered).GetValueNames() -contains "Firefox-$hash")) {
    Add-Item 'Value' $registered "Firefox-$hash"
  }
  Get-ScheduledTask -TaskPath '\Mozilla\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "* $hash" } |
    ForEach-Object { Add-Item 'Task' $_.TaskName }
}

# ---- Show, confirm, delete --------------------------------------------------------

if ($items.Count -eq 0) {
  Write-Host 'Nothing of Zen is left.'
  exit 0
}
Write-Host 'Found:'
foreach ($item in $items) {
  $where = $item.Path -replace '^Microsoft\.PowerShell\.Core\\Registry::HKEY_CURRENT_USER', 'HKCU:'
  if ($item.Value) { Write-Host ("  {0,-8} {1} -> {2}" -f $item.Kind, $where, $item.Value) }
  else { Write-Host ("  {0,-8} {1}" -f $item.Kind, $where) }
}
if ($WhatIfPreference) { exit 0 }
if ((Read-Host "`nDelete all of this, including Zen's profiles? [y/N]") -notmatch '^(y|yes)$') {
  Write-Host 'Nothing deleted.'
  exit 0
}

$failed = 0
foreach ($item in $items) {
  try {
    switch ($item.Kind) {
      'Value' { Remove-ItemProperty -LiteralPath $item.Path -Name $item.Value }
      'Task' { Unregister-ScheduledTask -TaskPath '\Mozilla\' -TaskName $item.Path -Confirm:$false }
      default { Remove-Item -LiteralPath $item.Path -Recurse -Force }
    }
  } catch {
    $failed++
    Write-Host "Not deleted: $($item.Path) $($item.Value) ($($_.Exception.Message))"
  }
}
if ($failed -gt 0) {
  Write-Host "$failed not deleted. Items in Program Files, ProgramData or the scheduled tasks may need PowerShell run as administrator."
  exit 1
}
Write-Host 'Done. Nothing of Zen is left.'
