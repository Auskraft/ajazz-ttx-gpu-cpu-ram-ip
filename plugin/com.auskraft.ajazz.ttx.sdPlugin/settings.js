(function () {
  'use strict';

  const prefix = 'com.auskraft.ajazz.ttx.';
  const metricIds = ['cpuTemperature', 'gpuTemperature', 'ramUsedGb', 'cpuLoad', 'gpuLoad', 'ip'];
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
      ipSeconds: Number(source.ipSeconds) === 5 ? 5 : 15,
      ipProgress: source.ipProgress === true,
      digitSize: Number.isFinite(digitSize)
        ? Math.min(digitSizeRange.max, Math.max(digitSizeRange.min, Math.round(digitSize)))
        : null
    };
  }

  const api = { metricIds, metricForAction, supportsTraffic, normalize, digitSizeRange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.AjazzSettings = api;
})();
