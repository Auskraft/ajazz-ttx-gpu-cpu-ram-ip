'use strict';

const { networkInterfaces } = require('node:os');
const WebSocket = require('./vendor/ws');
const { createPublicIpLookups } = require('./public-ip.js');
const { renderTile } = require('./render.js');
const { createTelemetry } = require('./telemetry.cjs');
const { metricIds, metricForAction, normalize } = require('./settings.js');

const numericMetrics = [...metricIds.filter((metric) => metric !== 'ip'), 'gpuHotspot'];
const historyLength = 30;
const tickInterval = 1000;

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
  let telemetry = null;
  let snapshot = {};
  let timer = null;

  function send(event, context, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
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
    const value = isAddress ? entry.ipValue : snapshot[metric] ?? null;
    const status = isAddress ? entry.ipStatus : value === null ? 'unavailable' : 'ready';
    const image = renderTile({
      metric,
      history: histories[metric] ?? [],
      value,
      settings,
      focus,
      country: entry.ipCountry,
      showFlag: Boolean(!focus && entry.showFlag),
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
    if (telemetry) {
      const needsHotspot = actions.some(({ metric, settings }) =>
        metric === 'gpuTemperature' && settings.gpuSensor === 'hotspot');
      telemetry.setGpuHotspotEnabled(needsHotspot);
      if (!needsHotspot) histories.gpuHotspot.length = 0;
    }
    if (!actions.some(isPublicIp)) publicIp.address.cancel();
    if (!actions.some(wantsCountry)) publicIp.location.cancel();
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
        focus: onscreen.get(context)?.focus ?? false,
        ipNextCheck: 0, gettingIp: null, ipValue: null, ipCountry: null, showFlag: false, ipStatus: 'loading',
        lastImage: null
      });
      syncCollectors();
      update(Date.now(), false);
    } else if (event === 'willDisappear') {
      onscreen.delete(context);
      syncCollectors();
    } else if (event === 'keyDown') {
      const entry = onscreen.get(context);
      if (!entry) return;
      entry.focus = !entry.focus;
      paint(entry);
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
