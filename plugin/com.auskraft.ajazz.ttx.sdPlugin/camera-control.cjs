'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { normalizeCameraId } = require('./settings.js');

const helper = path.join(__dirname, 'game-sensor', 'GameSensor.exe');
const runHelper = promisify(execFile);
const deviceStatuses = new Set(['enabled', 'disabled', 'unavailable']);
const requestReasons = new Set(['cancelled', 'failed', 'unavailable']);

async function readHelper(args, timeout) {
  if (process.platform !== 'win32') throw new Error('Windows camera helper is unavailable');
  try {
    const { stdout } = await runHelper(helper, ['camera', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      shell: false,
      timeout,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(error.killed ? 'Windows camera helper timed out' : 'Windows camera helper failed');
  }
}

async function readDevices() {
  const response = await readHelper(['--once'], 5000);
  if (!Array.isArray(response?.devices)) throw new Error('Windows camera list is unavailable');

  const devices = [];
  for (const entry of response.devices) {
    const id = normalizeCameraId(entry?.id);
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (id && name && deviceStatuses.has(entry.status)) {
      devices.push({ id, name, status: entry.status });
    }
  }
  return devices;
}

class CameraControl {
  #refreshing = null;
  #requestPending = false;

  refresh() {
    if (!this.#refreshing) {
      this.#refreshing = readDevices().finally(() => { this.#refreshing = null; });
    }
    return this.#refreshing;
  }

  async setEnabled(id, enabled) {
    const device = normalizeCameraId(id);
    if (!device || typeof enabled !== 'boolean') throw new Error('Invalid Windows camera request');
    if (this.#requestPending) throw new Error('A Windows camera request is already pending');

    this.#requestPending = true;
    try {
      const response = await readHelper(['--request', device, enabled ? 'enable' : 'disable'], 150000);
      if (typeof response?.changed !== 'boolean' || !deviceStatuses.has(response.status) ||
          (response.reason != null && !requestReasons.has(response.reason))) {
        throw new Error('Invalid response from Windows camera helper');
      }
      const { changed, status, reason } = response;
      return reason == null ? { changed, status } : { changed, status, reason };
    } finally {
      this.#requestPending = false;
    }
  }
}

module.exports = { CameraControl };
