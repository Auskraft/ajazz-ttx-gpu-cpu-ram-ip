'use strict';

const { execFile, spawn } = require('node:child_process');
const { realpath, stat } = require('node:fs/promises');
const { win32: path } = require('node:path');

const executableName = 'Bitwarden.exe';
const registryScript = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$currentVersion = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion"',
  '$appPath = "$currentVersion\\App Paths\\Bitwarden.exe"',
  '$uninstallPath = "$currentVersion\\Uninstall\\173a9bac-6f0d-50c4-8202-4744c69d091a"',
  '$candidates = @(',
  '  foreach ($hive in "CurrentUser", "LocalMachine") {',
  '    foreach ($view in "Registry64", "Registry32") {',
  '      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)',
  '      try {',
  '        $app = $base.OpenSubKey($appPath)',
  '        if ($app) { try { $app.GetValue("") } finally { $app.Dispose() } }',
  '        $vendor = $base.OpenSubKey($uninstallPath)',
  '        if ($vendor) {',
  '          try {',
  '            if ($vendor.GetValue("DisplayName") -eq "Bitwarden" -and $vendor.GetValue("Publisher") -eq "Bitwarden Inc.") {',
  '              $location = $vendor.GetValue("InstallLocation")',
  '              if ($location -is [string] -and $location.Trim()) { Join-Path $location "Bitwarden.exe" }',
  '              $icon = $vendor.GetValue("DisplayIcon")',
  '              if ($icon -is [string]) { $icon -replace ",\\s*-?\\d+\\s*$", "" }',
  '            }',
  '          } finally { $vendor.Dispose() }',
  '        }',
  '      } finally { $base.Dispose() }',
  '    }',
  '  }',
  ')',
  'ConvertTo-Json -InputObject $candidates -Compress'
].join('\n');

function localPath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().replace(/^"([^"]+)"$/, '$1');
  if (!/^[A-Za-z]:[\\/]/.test(candidate) || /["<>|?*:\x00-\x1f]/.test(candidate.slice(2))) return null;
  return path.normalize(candidate);
}

async function existingExecutable(value) {
  const candidate = localPath(value);
  if (!candidate || path.basename(candidate).toLowerCase() !== executableName.toLowerCase()) return null;
  try {
    const resolved = localPath(await realpath(candidate));
    if (resolved && path.basename(resolved).toLowerCase() === executableName.toLowerCase() && (await stat(resolved)).isFile()) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

function registryCandidates() {
  const systemRoot = localPath(process.env.SystemRoot);
  if (!systemRoot) return Promise.resolve([]);
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(registryScript, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      windowsHide: true, timeout: 4000, maxBuffer: 16384
    }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

async function findBitwarden(customPath) {
  if (process.platform !== 'win32') return null;
  if (customPath != null && (typeof customPath !== 'string' || customPath.trim())) {
    return existingExecutable(customPath);
  }
  const localAppData = localPath(process.env.LOCALAPPDATA);
  const roots = new Set([
    localAppData && path.join(localAppData, 'Programs'),
    localPath(process.env.ProgramW6432),
    localPath(process.env.ProgramFiles),
    localPath(process.env['ProgramFiles(x86)'])
  ]);
  for (const root of roots) {
    if (!root) continue;
    const executable = await existingExecutable(path.join(root, 'Bitwarden', executableName));
    if (executable) return executable;
  }
  for (const candidate of new Set(await registryCandidates())) {
    const executable = await existingExecutable(candidate);
    if (executable) return executable;
  }
  return null;
}

async function openBitwarden(customPath) {
  const executable = await findBitwarden(customPath);
  if (!executable) return false;
  return new Promise((resolve) => {
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      detached: true,
      stdio: 'ignore'
    });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', () => resolve(false));
  });
}

module.exports = { findBitwarden, openBitwarden };
