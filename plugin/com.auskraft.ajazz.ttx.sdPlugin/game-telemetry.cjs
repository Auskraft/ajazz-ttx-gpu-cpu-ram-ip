'use strict';

const { spawn } = require('node:child_process');
const { isIP } = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const helper = path.join(__dirname, 'game-sensor', 'GameSensor.exe');
const defaultTarget = '1.1.1.1';
const historyLength = 30;
const restartDelay = 3000;

function targetFor(settings) {
  const value = typeof settings?.pingTarget === 'string' ? settings.pingTarget.trim().toLowerCase() : '';
  const dnsName = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/i;
  return isIP(value) || dnsName.test(value) ? value : defaultTarget;
}

function letterFor(settings) {
  const value = typeof settings?.volumeLetter === 'string' ? settings.volumeLetter.trim().toUpperCase() : '';
  return /^[A-Z]:?$/.test(value) ? value[0] : 'C';
}

function makeChannel(args, onLine, onLost) {
  const maxSilence = args[0] === 'disk' ? 20000 : 10000;
  let worker = null;
  let retry = null;
  let watchdog = null;
  let closed = false;

  function start() {
    if (closed || process.platform !== 'win32') return;
    const child = spawn(helper, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    worker = child;
    child.on('error', () => {}); // close handles both spawn failure and normal exit
    child.stdin.on('error', () => {}); // child can exit after the host queues a toggle
    function watch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => child.kill(), maxSilence);
      watchdog.unref();
    }
    watch();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (closed || worker !== child || line.length > 8192) return;
      let reading;
      try {
        reading = JSON.parse(line);
      } catch {
        return;
      }
      watch();
      onLine(reading);
    });
    child.once('close', () => {
      lines.close();
      if (worker !== child) return;
      clearTimeout(watchdog);
      worker = null;
      if (!closed) {
        onLost();
        retry = setTimeout(start, restartDelay);
        retry.unref();
      }
    });
  }
  start();

  return {
    write(command) {
      if (closed || !worker?.stdin.writable) return false;
      worker.stdin.write(command + '\n');
      return true;
    },
    close() {
      closed = true;
      clearTimeout(retry);
      clearTimeout(watchdog);
      const child = worker;
      if (!child) return;
      child.stdin.end();
      const force = setTimeout(() => child.kill(), 1500);
      force.unref();
      child.once('close', () => clearTimeout(force));
    },
  };
}

function createGameTelemetry(onMicrophoneReading) {
  let micChannel = null;
  let diskChannel = null;
  let mic = null;
  let volumes = new Map();
  const network = new Map();

  function setMic(reading) {
    if (reading?.db === mic?.db && reading?.muted === mic?.muted) return;
    mic = reading;
    onMicrophoneReading?.();
  }

  function readMic(reading) {
    if (typeof reading?.muted !== 'boolean') {
      setMic(null);
      return;
    }
    const db = Number.isFinite(reading.db) ? Math.max(-60, Math.min(0, reading.db)) : null;
    setMic({ db: reading.muted ? null : db, muted: reading.muted });
  }

  function readDisks(reading) {
    if (!Array.isArray(reading)) return;
    volumes = new Map(reading.filter((disk) =>
      /^[A-Z]$/.test(disk?.letter) &&
      ['SSD', 'HDD', 'ДИСК'].includes(disk.type) &&
      Number.isFinite(disk.usedGb) && Number.isFinite(disk.totalGb) && Number.isFinite(disk.freePct)
    ).map((disk) => [disk.letter, disk]));
  }

  function startNetwork(target) {
    const samples = [];
    const entry = { samples, channel: makeChannel(['network', target], (reading) => {
      if (!reading || !(reading.pingMs === null || Number.isFinite(reading.pingMs))) return;
      samples.push(reading.pingMs);
      if (samples.length > historyLength) samples.shift();
    }, () => { samples.length = 0; }) };
    network.set(target, entry);
  }

  function networkValue(target) {
    const samples = network.get(target)?.samples;
    if (!samples?.length) return null;
    const successful = samples.filter(Number.isFinite);
    const deltas = successful.slice(1).map((value, index) => Math.abs(value - successful[index]));
    return {
      pingMs: samples.at(-1),
      lossPct: Math.round(100 * (samples.length - successful.length) / samples.length),
      jitterMs: deltas.length ? Math.round(deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length) : null,
      history: samples.slice(),
    };
  }

  function sync(actions) {
    const visible = [...actions];
    const micVisible = visible.some(({ metric }) => metric === 'microphone');
    const diskVisible = visible.some(({ metric }) => metric === 'disk');
    const targets = new Set(visible.filter(({ metric }) => metric === 'network').map(({ settings }) => targetFor(settings)));
    if (micVisible && !micChannel) micChannel = makeChannel(['microphone'], readMic, () => setMic(null));
    if (!micVisible && micChannel) {
      micChannel.close();
      micChannel = null;
      mic = null;
    }
    if (diskVisible && !diskChannel) diskChannel = makeChannel(['disk'], readDisks, () => volumes.clear());
    if (!diskVisible && diskChannel) {
      diskChannel.close();
      diskChannel = null;
      volumes.clear();
    }
    for (const [target, { channel }] of network) {
      if (targets.has(target)) continue;
      channel.close();
      network.delete(target);
    }
    for (const target of targets) {
      if (!network.has(target)) startNetwork(target);
    }
  }

  return {
    sync,
    value(metric, settings) {
      if (metric === 'microphone') return mic;
      if (metric === 'disk') return volumes.get(letterFor(settings)) ?? null;
      if (metric === 'network') return networkValue(targetFor(settings));
      return null;
    },
    toggleMicrophone() {
      return mic !== null && (micChannel?.write('toggle') ?? false);
    },
    close() {
      sync([]);
    },
  };
}

module.exports = { createGameTelemetry };
