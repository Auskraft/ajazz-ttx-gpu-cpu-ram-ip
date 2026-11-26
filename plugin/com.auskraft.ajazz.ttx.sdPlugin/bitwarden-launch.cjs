'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

function findBitwarden() {
  if (process.platform !== 'win32') return null;
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ];
  return roots.filter((root) => root && path.isAbsolute(root))
    .map((root) => path.join(root, 'Bitwarden', 'Bitwarden.exe'))
    .find(existsSync) ?? null;
}

function openBitwarden() {
  const executable = findBitwarden();
  if (!executable) return Promise.resolve(false);
  return new Promise((resolve) => {
    const process = spawn(executable, [], {
      cwd: path.dirname(executable),
      detached: true,
      stdio: 'ignore'
    });
    process.once('spawn', () => {
      process.unref();
      resolve(true);
    });
    process.once('error', () => resolve(false));
  });
}

module.exports = { findBitwarden, openBitwarden };
