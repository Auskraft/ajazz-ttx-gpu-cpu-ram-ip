(function () {
  'use strict';

  const prefix = 'com.auskraft.ajazz.ttx.';
  const hardwareMetricIds = ['cpuTemperature', 'gpuTemperature', 'ramUsedGb', 'cpuLoad', 'gpuLoad'];
  const metricIds = [...hardwareMetricIds, 'ip', 'fps', 'microphone', 'network', 'disk', 'bitwarden'];
  const themes = ['bars', 'lines', 'large'];
  const digitSizeRange = Object.freeze({ min: 12, max: 30 });

  function metricForAction(action) {
    if (typeof action !== 'string' || !action.startsWith(prefix)) return null;
    const metric = action.slice(prefix.length);
    return metricIds.includes(metric) ? metric : null;
  }

  function supportsTraffic(metric) {
    return metric === 'cpuTemperature' || metric === 'cpuLoad' ||
      metric === 'gpuTemperature' || metric === 'gpuLoad';
  }

  function normalizeFpsProcess(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[a-z0-9_][a-z0-9_. -]{0,75}$/.test(name) || name.endsWith('.')) return 'korabli.exe';
    return name.endsWith('.exe') ? name : name + '.exe';
  }

  function normalizePingTarget(value) {
    const target = typeof value === 'string' ? value.trim() : '';
    const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
    const ipv6 = /^(?:[0-9a-f:.]{0,38}:[0-9a-f:.]{0,38})$/i;
    return target.length <= 253 && (hostname.test(target) || ipv6.test(target)) ? target : '1.1.1.1';
  }

  function normalize(settings) {
    const source = settings ?? {};
    const size = source.digitSize;
    const digitSize = typeof size === 'number' || (typeof size === 'string' && size.trim())
      ? Number(size) : NaN;

    return {
      theme: themes.includes(source.theme) ? source.theme : 'bars',
      traffic: source.traffic !== false,
      gpuSensor: source.gpuSensor === 'hotspot' ? 'hotspot' : 'core',
      ipMode: source.ipMode === 'local' ? 'local' : 'public',
      ipDisplay: source.ipDisplay === 'alternate' ? 'alternate' : 'digits',
      ipSeconds: Number(source.ipSeconds) === 5 ? 5 : 15,
      ipProgress: source.ipProgress === true,
      digitSize: Number.isFinite(digitSize)
        ? Math.min(digitSizeRange.max, Math.max(digitSizeRange.min, Math.round(digitSize)))
        : null,
      fpsProcess: normalizeFpsProcess(source.fpsProcess),
      pingTarget: normalizePingTarget(source.pingTarget),
      volumeLetter: typeof source.volumeLetter === 'string' && /^[a-z]:?$/i.test(source.volumeLetter.trim())
        ? source.volumeLetter.trim()[0].toUpperCase() : 'C'
    };
  }

  const api = { metricIds, hardwareMetricIds, metricForAction, supportsTraffic, normalize, normalizeFpsProcess, digitSizeRange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.AjazzSettings = api;
})();
