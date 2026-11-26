'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { normalizeAudioOutputId } = require('./settings.js');

const helper = path.join(__dirname, 'game-sensor', 'GameSensor.exe');
const requestTimeout = 5000;

function createAudioOutput() {
  let worker = null;
  let closed = false;

  function stop(channel, error) {
    if (worker !== channel) return;
    worker = null;
    channel.lines.close();
    for (const request of channel.pending.splice(0)) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }

  function start() {
    const child = spawn(helper, ['output'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = readline.createInterface({ input: child.stdout });
    const channel = { child, lines, pending: [] };
    worker = channel;
    const fail = (error) => {
      if (worker !== channel) return;
      stop(channel, error);
      child.kill();
    };

    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.once('close', () => fail(new Error('Windows audio helper exited')));
    lines.on('line', (line) => {
      if (worker !== channel) return;
      const request = channel.pending.shift();
      if (!request) return;
      clearTimeout(request.timeout);
      try {
        request.resolve(JSON.parse(line));
      } catch (error) {
        request.reject(error);
      }
    });
    return channel;
  }

  function send(command) {
    if (closed || process.platform !== 'win32') {
      return Promise.reject(new Error('Windows audio helper is unavailable'));
    }
    return new Promise((resolve, reject) => {
      const channel = worker ?? start();
      const timeout = setTimeout(() => {
        stop(channel, new Error('Windows audio helper timed out'));
        channel.child.kill();
      }, requestTimeout);
      channel.pending.push({ resolve, reject, timeout });
      channel.child.stdin.write(command + '\n');
    });
  }

  return {
    async list() {
      const reading = await send('list');
      if (!Array.isArray(reading?.devices)) throw new Error('Windows audio devices are unavailable');
      const devices = reading.devices.filter((device) =>
        normalizeAudioOutputId(device?.id) && typeof device.name === 'string' && device.name.trim());
      const volumePercent = Number.isFinite(reading.volumePercent) && reading.volumePercent >= 0 && reading.volumePercent <= 100
        ? reading.volumePercent : null;
      return { devices, activeId: normalizeAudioOutputId(reading.activeId) || null, volumePercent };
    },
    async setDefault(id) {
      const endpoint = normalizeAudioOutputId(id);
      if (!endpoint) return false;
      const reading = await send('switch ' + endpoint);
      if (typeof reading?.switched !== 'boolean') throw new Error('Windows audio switch failed');
      return reading.switched;
    },
    close() {
      closed = true;
      if (!worker) return;
      const channel = worker;
      stop(channel, new Error('Windows audio helper is closed'));
      const child = channel.child;
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), requestTimeout);
      timeout.unref();
      child.once('close', () => clearTimeout(timeout));
    },
  };
}

module.exports = { createAudioOutput };
