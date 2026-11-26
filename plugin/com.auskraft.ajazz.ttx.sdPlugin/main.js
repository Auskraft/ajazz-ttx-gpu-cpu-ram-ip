'use strict';

const { networkInterfaces } = require('node:os');
const WebSocket = require('./vendor/ws');
const { createPublicIpLookups } = require('./public-ip.js');
const { renderTile } = require('./render.js');
const { createTelemetry } = require('./telemetry.cjs');
const { createGameTelemetry } = require('./game-telemetry.cjs');
const { createFpsMonitor } = require('./fps-telemetry.cjs');
const { createAudioOutput } = require('./audio-output.cjs');
const { openBitwarden } = require('./bitwarden-launch.cjs');
const { hardwareMetricIds, metricForAction, normalize } = require('./settings.js');

const numericMetrics = [...hardwareMetricIds, 'gpuHotspot'];
const gameMetrics = new Set(['microphone', 'network', 'disk']);
const historyLength = 30;
const tickInterval = 1000;
const audioPollInterval = 2000;

function isPublicIp({ metric, settings }) {
  return metric === 'ip' && settings.ipMode === 'public';
}

function wantsCountry(entry) {
  return isPublicIp(entry) && entry.settings.ipDisplay === 'alternate';
}

function localIp() {
  const entries = Object.entries(networkInterfaces());
  const ipv4 = (interfaces) => interfaces.find((item) =>
    !item.internal && item.family === 'IPv4' && !item.address.startsWith('169.254.'));
  const physical = entries.filter(([name]) => !/virtual|vethernet|vmware|vbox|hyper-v|wsl|vpn|tap|tailscale/i.test(name));
  return ipv4(physical.flatMap(([, items]) => items))?.address ??
    ipv4(entries.flatMap(([, items]) => items))?.address ?? null;
}

function startPlugin({ port, uuid, registerEvent }) {
  const socket = new WebSocket('ws://127.0.0.1:' + port, { maxPayload: 256 * 1024 });
  const onscreen = new Map();
  const publicIp = createPublicIpLookups();
  const histories = Object.fromEntries(numericMetrics.map((name) => [name, []]));
  const fpsHistories = new Map();
  let telemetry = null;
  let game = null;
  let fpsMonitor = null;
  let snapshot = {};
  let fpsSnapshot = {};
  let audioOutput = null;
  let audioSnapshot = null;
  let audioRead = null;
  let audioNextCheck = 0;
  let audioSwitching = false;
  let timer = null;

  function send(event, context, payload, action) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload, action }));
  }

  async function resolveAddress(entry, request, withCountry) {
    const isCurrent = () => onscreen.get(entry.context) === entry && entry.gettingIp === request;
    let result = await request;
    if (!isCurrent()) return;
    if (!result && withCountry) {
      result = await publicIp.address.read(Date.now());
      if (!isCurrent()) return;
    }

    const country = result?.country ?? null;
    entry.showFlag = Boolean(country && entry.ipCountry && !entry.showFlag);
    entry.ipCountry = country;
    entry.gettingIp = null;
    entry.ipValue = result?.address ?? null;
    entry.ipStatus = result?.address ? 'ready' : 'unavailable';
    if (withCountry) entry.ipNextCheck = Date.now() + entry.settings.ipSeconds * 1000;
    paint(entry);
  }

  function refreshAddress(entry, now) {
    if (now < entry.ipNextCheck || entry.gettingIp) return;
    const mode = entry.settings.ipMode;
    entry.ipNextCheck = now + entry.settings.ipSeconds * 1000;
    if (mode === 'local') {
      entry.ipValue = localIp();
      entry.ipStatus = entry.ipValue ? 'ready' : 'unavailable';
      return;
    }

    const withCountry = wantsCountry(entry);
    const request = (withCountry ? publicIp.location : publicIp.address).read(now);
    entry.gettingIp = request;
    void resolveAddress(entry, request, withCountry);
  }

  function paint(entry, now = Date.now()) {
    const { context, settings, focus } = entry;
    const metric = entry.metric === 'gpuTemperature' && settings.gpuSensor === 'hotspot'
      ? 'gpuHotspot' : entry.metric;
    const isAddress = metric === 'ip';
    let value = snapshot[metric] ?? null;
    let history = histories[metric] ?? [];
    let status;
    if (isAddress) {
      value = entry.ipValue;
      status = entry.ipStatus;
    } else if (metric === 'fps') {
      value = fpsSnapshot[settings.fpsProcess] ?? null;
      history = fpsHistories.get(settings.fpsProcess) ?? [];
      status = value?.status;
    } else if (metric === 'audioOutput') {
      value = audioOutputValue(settings, audioSnapshot);
      status = audioSnapshot?.devices.length ? 'ready' : 'unavailable';
    } else if (gameMetrics.has(metric)) {
      value = game?.value(metric, settings) ?? null;
      history = value?.history ?? [];
    }
    const image = renderTile({
      metric,
      history,
      value,
      settings,
      focus,
      country: entry.ipCountry,
      showFlag: Boolean(!focus && entry.showFlag),
      snapshot,
      ipSecondsRemaining: Math.min(settings.ipSeconds, Math.max(0, (entry.ipNextCheck - now) / 1000)),
      status: status ?? (value === null ? 'unavailable' : 'ready')
    });
    if (image === entry.lastImage) return;
    entry.lastImage = image;
    send('setImage', context, { target: 0, image });
  }

  function paintMics() {
    for (const entry of onscreen.values()) {
      if (entry.metric === 'microphone') paint(entry);
    }
  }

  function audioOutputValue({ audioOutputA: first, audioOutputB: second }, reading) {
    const devices = reading?.devices ?? [];
    const active = devices.find(({ id }) => id === reading.activeId);
    const selected = [first, second];
    const configured = Boolean(first && second && first !== second);
    const pairAvailable = configured && selected.every((endpoint) => devices.some(({ id }) => id === endpoint));
    const activeIndex = configured && active ? selected.indexOf(active.id) : -1;
    const slot = activeIndex >= 0 ? activeIndex + 1 : null;
    return { name: active?.name ?? '', slot, configured, pairAvailable };
  }

  function readAudioOutputs() {
    if (audioRead) return audioRead;
    const output = audioOutput;
    if (!output) return Promise.resolve(null);
    audioNextCheck = Date.now() + audioPollInterval;
    audioRead = output.list().catch(() => null).then((reading) => {
      if (audioOutput !== output) return null;
      audioSnapshot = reading;
      audioRead = null;
      for (const entry of onscreen.values()) {
        if (entry.metric === 'audioOutput') paint(entry);
      }
      return reading;
    });
    return audioRead;
  }

  async function sendAudioOutputs(entry, action, requestId) {
    const reading = await readAudioOutputs();
    if (onscreen.get(entry.context) !== entry) return;
    send('sendToPropertyInspector', entry.context, {
      requestId, available: Boolean(reading), devices: reading?.devices ?? []
    }, action);
  }

  async function switchAudioOutput(entry) {
    if (audioSwitching) return;
    const output = audioOutput;
    const { audioOutputA: first, audioOutputB: second } = entry.settings;
    if (!output || !first || !second || first === second) {
      send('showAlert', entry.context);
      return;
    }

    audioSwitching = true;
    try {
      const reading = await readAudioOutputs();
      if (onscreen.get(entry.context) !== entry || audioOutput !== output ||
          entry.settings.audioOutputA !== first || entry.settings.audioOutputB !== second) return;
      if (audioOutputValue(entry.settings, reading).pairAvailable) {
        const target = reading.activeId === first ? second : first;
        const switched = await output.setDefault(target);
        const confirmed = await readAudioOutputs();
        if (switched && confirmed?.activeId === target) return;
      }
    } catch {
      if (audioOutput === output) void readAudioOutputs();
    } finally {
      audioSwitching = false;
    }
    if (onscreen.get(entry.context) === entry) send('showAlert', entry.context);
  }

  function updateFps(sample) {
    fpsSnapshot = fpsMonitor?.snapshot() ?? {};
    if (!sample) return;
    for (const [name, reading] of Object.entries(fpsSnapshot)) {
      const history = fpsHistories.get(name);
      if (!history) continue;
      if (!Number.isFinite(reading?.frameMs)) {
        history.length = 0;
        continue;
      }
      history.push(reading);
      if (history.length > historyLength) history.shift();
    }
  }

  function update(now = Date.now(), sample = true) {
    if (telemetry) {
      snapshot = telemetry.snapshot();
      if (sample) {
        for (const metric of numericMetrics) {
          const history = histories[metric];
          if (!Number.isFinite(snapshot[metric])) {
            history.length = 0;
            continue;
          }
          history.push(snapshot[metric]);
          if (history.length > historyLength) history.shift();
        }
      }
    }
    if (fpsMonitor) updateFps(sample);
    if (audioOutput && !audioSwitching && now >= audioNextCheck) void readAudioOutputs();
    for (const entry of onscreen.values()) {
      if (entry.metric === 'ip') refreshAddress(entry, now);
      paint(entry, now);
    }
  }

  function syncCollectors() {
    const actions = [...onscreen.values()];
    const needsAudioOutput = actions.some(({ metric }) => metric === 'audioOutput');
    if (needsAudioOutput && !audioOutput) {
      audioOutput = createAudioOutput();
    } else if (!needsAudioOutput && audioOutput) {
      audioOutput.close();
      audioOutput = null;
      audioSnapshot = null;
      audioRead = null;
      audioNextCheck = 0;
    }
    const needsSensors = actions.some(({ metric }) => hardwareMetricIds.includes(metric));
    if (needsSensors && !telemetry) telemetry = createTelemetry();
    else if (!needsSensors && telemetry) {
      telemetry.close();
      telemetry = null;
      snapshot = {};
      for (const history of Object.values(histories)) history.length = 0;
    }
    if (telemetry) {
      const needsHotspot = actions.some(({ metric, settings }) =>
        metric === 'gpuTemperature' && settings.gpuSensor === 'hotspot');
      telemetry.setGpuHotspotEnabled(needsHotspot);
      if (!needsHotspot) histories.gpuHotspot.length = 0;
    }
    if (actions.some(({ metric }) => gameMetrics.has(metric))) {
      if (!game) game = createGameTelemetry(paintMics);
      game.sync(actions);
    } else if (game) {
      game.close();
      game = null;
    }

    const fpsProcesses = new Set(actions.filter(({ metric }) => metric === 'fps')
      .map(({ settings }) => settings.fpsProcess));
    if (fpsProcesses.size) {
      if (!fpsMonitor) fpsMonitor = createFpsMonitor();
      for (const name of fpsHistories.keys()) if (!fpsProcesses.has(name)) fpsHistories.delete(name);
      for (const name of fpsProcesses) if (!fpsHistories.has(name)) fpsHistories.set(name, []);
      fpsMonitor.setTargets([...fpsProcesses]);
      updateFps(false);
    } else if (fpsMonitor) {
      fpsMonitor.close();
      fpsMonitor = null;
      fpsSnapshot = {};
      fpsHistories.clear();
    }

    if (!actions.some(isPublicIp)) publicIp.address.cancel();
    if (!actions.some(wantsCountry)) publicIp.location.cancel();
    const needsTimer = actions.some(({ metric }) => metric !== 'bitwarden');
    if (needsTimer && !timer) timer = setInterval(update, tickInterval);
    else if (!needsTimer && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function press(entry) {
    if (entry.metric === 'audioOutput') {
      void switchAudioOutput(entry);
      return;
    }
    if (entry.metric === 'bitwarden') {
      void openBitwarden().then((started) => {
        if (onscreen.get(entry.context) !== entry) return;
        if (!started) send('showAlert', entry.context);
        paint(entry);
      });
      return;
    }
    if (entry.metric === 'microphone') {
      if (!game?.toggleMicrophone()) send('showAlert', entry.context);
      return;
    }
    entry.focus = !entry.focus;
    paint(entry);
  }

  function onHostMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { action, event, context, device, payload } = message ?? {};
    if (event === 'deviceDidDisconnect') {
      for (const entry of onscreen.values()) {
        if (entry.device === device) onscreen.delete(entry.context);
      }
      syncCollectors();
      return;
    }
    if (typeof context !== 'string') return;

    if (event === 'willAppear') {
      const metric = metricForAction(action);
      if (!metric) return;
      onscreen.set(context, {
        context, device, metric, settings: normalize(payload?.settings),
        focus: onscreen.get(context)?.focus ?? false,
        ipNextCheck: 0, gettingIp: null, ipValue: null, ipCountry: null, showFlag: false, ipStatus: 'loading',
        lastImage: null
      });
      syncCollectors();
      update(Date.now(), false);
    } else if (event === 'willDisappear') {
      onscreen.delete(context);
      syncCollectors();
    } else if (event === 'sendToPlugin' && metricForAction(action) === 'audioOutput' &&
        payload?.request === 'audioOutputs' && typeof payload.requestId === 'string' &&
        /^\d{1,16}-\d{1,8}$/.test(payload.requestId)) {
      // Stream Dock can pass the inspector UUID as the message context.
      const entry = onscreen.get(context) ?? onscreen.get(payload.actionContext);
      if (entry?.metric === 'audioOutput') void sendAudioOutputs(entry, action, payload.requestId);
    } else if (event === 'keyDown') {
      const entry = onscreen.get(context);
      if (entry) press(entry);
    } else if (event === 'didReceiveSettings') {
      const entry = onscreen.get(context);
      if (!entry) return;
      const settings = normalize(payload?.settings);
      const ipModeChanged = entry.metric === 'ip' && entry.settings.ipMode !== settings.ipMode;
      const ipDisplayChanged = entry.metric === 'ip' && entry.settings.ipDisplay !== settings.ipDisplay;
      if (ipModeChanged || ipDisplayChanged) {
        entry.gettingIp = null;
        if (ipModeChanged) entry.ipValue = null;
        entry.ipCountry = null;
        entry.showFlag = false;
        entry.ipStatus = entry.ipValue ? 'ready' : 'loading';
        entry.ipNextCheck = 0;
      } else if (entry.settings.ipSeconds !== settings.ipSeconds) {
        entry.ipNextCheck = Date.now() + settings.ipSeconds * 1000;
      }
      entry.settings = settings;
      syncCollectors();
      update(Date.now(), false);
    }
  }

  socket.on('open', () => socket.send(JSON.stringify({ uuid, event: registerEvent })));
  socket.on('message', onHostMessage);
  socket.on('error', () => console.error('Stream Dock connection failed.'));

  function stop() {
    onscreen.clear();
    syncCollectors();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  socket.on('close', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function launch(argv) {
  const flags = new Map();
  for (let index = 0; index + 1 < argv.length; index += 2) flags.set(argv[index], argv[index + 1]);
  const port = Number(flags.get('-port'));
  const uuid = flags.get('-pluginUUID');
  const registerEvent = flags.get('-registerEvent');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !uuid || !registerEvent) {
    console.error('Launch this plugin from Stream Dock.');
    return;
  }
  startPlugin({ port, uuid, registerEvent });
}

launch(process.argv.slice(2));
