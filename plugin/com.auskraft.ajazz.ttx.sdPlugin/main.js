'use strict';

const { networkInterfaces } = require('node:os');
const { isIPv4 } = require('node:net');
const WebSocket = require('./vendor/ws');
const { renderTile } = require('./render.js');
const { createTelemetry } = require('./telemetry.cjs');
const { metricIds, metricForAction, normalize } = require('./settings.js');

const numericMetrics = metricIds.filter((metric) => metric !== 'ip');
const historyLength = 30;
const tickInterval = 1000;
const minIpCache = 4500;

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
  const histories = Object.fromEntries(numericMetrics.map((name) => [name, []]));
  let telemetry = null;
  let snapshot = {};
  let timer = null;
  let publicRequest = null;
  let publicController = null;
  let publicCheckedAt = -Infinity;
  let publicValue = null;

  function send(event, context, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
  }

  function readPublicIp(now) {
    if (publicRequest) return publicRequest;
    if (now - publicCheckedAt < minIpCache) return Promise.resolve(publicValue);

    publicCheckedAt = now;
    const controller = new AbortController();
    publicController = controller;
    const timeout = setTimeout(() => controller.abort(), 3500);
    publicRequest = fetch('https://api.ipify.org', {
      signal: controller.signal,
      redirect: 'error'
    }).then(async (response) => {
      if (!response.ok) return null;
      const address = (await response.text()).trim();
      return isIPv4(address) ? address : null;
    }).catch(() => null).then((address) => {
      publicValue = address;
      return address;
    }).finally(() => {
      clearTimeout(timeout);
      publicRequest = null;
      publicController = null;
    });
    return publicRequest;
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

    const request = readPublicIp(now);
    entry.gettingIp = request;
    request.then((address) => {
      if (onscreen.get(entry.context) !== entry || entry.gettingIp !== request) return;
      entry.gettingIp = null;
      entry.ipValue = address;
      entry.ipStatus = address ? 'ready' : 'unavailable';
      paint(entry, Date.now());
    });
  }

  function paint(entry, now) {
    const { context, metric, settings } = entry;
    const isAddress = metric === 'ip';
    const value = isAddress ? entry.ipValue : snapshot[metric] ?? null;
    const status = isAddress ? entry.ipStatus : value === null ? 'unavailable' : 'ready';
    const image = renderTile({
      metric,
      history: histories[metric] ?? [],
      value,
      settings,
      snapshot,
      ipSecondsRemaining: Math.min(settings.ipSeconds, Math.max(0, (entry.ipNextCheck - now) / 1000)),
      status
    });
    if (image === entry.lastImage) return;
    entry.lastImage = image;
    send('setImage', context, { target: 0, image });
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
    for (const entry of onscreen.values()) {
      if (entry.metric === 'ip') refreshAddress(entry, now);
      paint(entry, now);
    }
  }

  function syncCollectors() {
    const actions = [...onscreen.values()];
    const needsSensors = actions.some(({ metric }) => metric !== 'ip');
    if (needsSensors && !telemetry) telemetry = createTelemetry();
    else if (!needsSensors && telemetry) {
      telemetry.close();
      telemetry = null;
      snapshot = {};
      for (const history of Object.values(histories)) history.length = 0;
    }
    if (!actions.some(({ metric, settings }) => metric === 'ip' && settings.ipMode === 'public')) {
      publicController?.abort();
    }
    if (actions.length && !timer) timer = setInterval(update, tickInterval);
    else if (!actions.length && timer) {
      clearInterval(timer);
      timer = null;
    }
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
        ipNextCheck: 0, gettingIp: null, ipValue: null, ipStatus: 'loading',
        lastImage: null
      });
      syncCollectors();
      update(Date.now(), false);
    } else if (event === 'willDisappear') {
      onscreen.delete(context);
      syncCollectors();
    } else if (event === 'didReceiveSettings') {
      const entry = onscreen.get(context);
      if (!entry) return;
      const settings = normalize(payload?.settings);
      if (entry.settings.ipMode !== settings.ipMode) {
        entry.gettingIp = null;
        entry.ipValue = null;
        entry.ipStatus = 'loading';
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
