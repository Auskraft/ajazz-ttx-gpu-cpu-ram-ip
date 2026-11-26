'use strict';

const { spawn } = require('node:child_process');
const { isIP } = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const { normalizeNetworkAdapterId, topProcessModes } = require('./settings.js');

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

function makeChannel(args, onLine, onLost, initialCommand) {
  const systemStream = args[0] === 'system';
  const maxSilence = args[0] === 'disk' || systemStream ? 20000 : 10000;
  const maxLineSize = systemStream ? 128 * 1024 : 8192;
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
      if (closed || worker !== child || line.length > maxLineSize) return;
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
    if (initialCommand) child.stdin.write(initialCommand() + '\n');
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

function nonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function percent(value) {
  const reading = nonnegative(value);
  return reading === null ? null : Math.min(100, reading);
}

function topProcess(reading, field, normalizeValue) {
  if (typeof reading?.name !== 'string' || !reading.name.trim()) return null;
  const value = normalizeValue(reading[field]);
  if (value === null) return null;
  const pid = Number.isSafeInteger(reading.pid) && reading.pid > 0 ? reading.pid : null;
  return { name: reading.name, pid, [field]: value };
}

function createGameTelemetry(onMicrophoneReading) {
  let micChannel = null;
  let diskChannel = null;
  let mic = null;
  let volumes = new Map();
  const network = new Map();
  let systemChannel = null;
  let systemDemand = new Set();
  let diskActivity = new Map();
  let interfaces = null;
  let defaultInterfaceId = '';
  let topCpu = null;
  let topGpu = null;
  let topRam = null;
  const adapterWaiters = new Set();

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

  function availableAdapters() {
    return interfaces?.map(({ id, name }) => ({ id, name })) ?? null;
  }

  function resolveAdapterWaiters(adapters) {
    for (const complete of adapterWaiters) complete(adapters);
  }

  function clearSystem() {
    diskActivity.clear();
    interfaces = null;
    defaultInterfaceId = '';
    topCpu = null;
    topGpu = null;
    topRam = null;
    resolveAdapterWaiters(null);
  }

  function readSystem(reading) {
    if (!reading || typeof reading !== 'object') return;
    if (systemDemand.has('disk')) {
      diskActivity = new Map((Array.isArray(reading.disks) ? reading.disks : [])
        .filter((disk) => /^[A-Z]$/.test(disk?.letter))
        .map((disk) => [disk.letter, {
          letter: disk.letter,
          readBytesPerSecond: nonnegative(disk.readBytesPerSecond),
          writeBytesPerSecond: nonnegative(disk.writeBytesPerSecond),
          activePercent: percent(disk.activePercent)
        }]));
    }
    if (systemDemand.has('network') && Array.isArray(reading.interfaces)) {
      interfaces = reading.interfaces.filter((adapter) =>
        normalizeNetworkAdapterId(adapter?.id) && typeof adapter.name === 'string' && adapter.name.trim()
      ).map((adapter) => ({
        id: adapter.id,
        name: adapter.name,
        receiveBytesPerSecond: nonnegative(adapter.receiveBytesPerSecond),
        sendBytesPerSecond: nonnegative(adapter.sendBytesPerSecond)
      }));
      defaultInterfaceId = normalizeNetworkAdapterId(reading.defaultInterfaceId);
      resolveAdapterWaiters(availableAdapters());
    }
    if (systemDemand.has('process-cpu')) topCpu = topProcess(reading.topCpu, 'cpuPercent', percent);
    if (systemDemand.has('process-gpu')) topGpu = topProcess(reading.topGpu, 'gpuPercent', percent);
    if (systemDemand.has('process-ram')) topRam = topProcess(reading.topRam, 'memoryBytes', nonnegative);
  }

  function networkAdapters() {
    if (interfaces) return Promise.resolve(availableAdapters());
    if (!systemDemand.has('network')) return Promise.resolve(null);
    return new Promise((resolve) => {
      const complete = (adapters) => {
        clearTimeout(deadline);
        adapterWaiters.delete(complete);
        resolve(adapters);
      };
      const deadline = setTimeout(() => complete(null), 5000);
      deadline.unref?.();
      adapterWaiters.add(complete);
    });
  }

  function networkSpeed(settings) {
    if (!interfaces) return null;
    const id = settings.networkAdapterId || defaultInterfaceId;
    const active = interfaces.filter(({ receiveBytesPerSecond, sendBytesPerSecond }) =>
      receiveBytesPerSecond !== null || sendBytesPerSecond !== null);
    const adapter = id ? interfaces.find(({ id: current }) => current === id) : active.length === 1 ? active[0] : null;
    if (!adapter) return null;
    return {
      adapterId: adapter.id,
      adapterName: adapter.name,
      receiveBytesPerSecond: adapter.receiveBytesPerSecond,
      sendBytesPerSecond: adapter.sendBytesPerSecond
    };
  }

  function syncSystem(actions) {
    const next = new Set();
    if (actions.some(({ metric }) => metric === 'diskActivity')) next.add('disk');
    if (actions.some(({ metric }) => metric === 'networkSpeed')) next.add('network');
    for (const mode of topProcessModes) {
      if (actions.some(({ metric, settings }) => (metric === 'topGpu' && mode === 'gpu') ||
        (metric === 'topProcess' && (settings.topProcessMode === mode || settings.topProcessMode === 'rotate')))) {
        next.add('process-' + mode);
      }
    }
    if (next.size === systemDemand.size && [...next].every((family) => systemDemand.has(family))) return;
    systemDemand = next;

    if (!next.size) {
      systemChannel?.close();
      systemChannel = null;
      clearSystem();
      return;
    }
    if (!next.has('disk')) diskActivity.clear();
    if (!next.has('network')) {
      interfaces = null;
      defaultInterfaceId = '';
      resolveAdapterWaiters(null);
    }
    if (!next.has('process-cpu')) topCpu = null;
    if (!next.has('process-gpu')) topGpu = null;
    if (!next.has('process-ram')) topRam = null;

    const command = () => 'watch ' + [...systemDemand].join(' ');
    if (systemChannel) systemChannel.write(command());
    else systemChannel = makeChannel(['system'], readSystem, clearSystem, command);
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
    syncSystem(visible);
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
      if (metric === 'diskActivity') return diskActivity.get(letterFor(settings)) ?? null;
      if (metric === 'networkSpeed') return networkSpeed(settings);
      if (metric === 'topGpu' || (metric === 'topProcess' && settings.topProcessMode === 'gpu')) return topGpu;
      if (metric === 'topProcess') return settings.topProcessMode === 'ram' ? topRam : topCpu;
      return null;
    },
    networkAdapters,
    toggleMicrophone() {
      return mic !== null && (micChannel?.write('toggle') ?? false);
    },
    close() {
      sync([]);
    },
  };
}

module.exports = { createGameTelemetry };
