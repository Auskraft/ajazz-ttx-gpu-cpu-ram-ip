(function () {
  'use strict';

  const prefix = 'com.auskraft.ajazz.ttx.';
  const metricIds = ['cpuTemperature', 'gpuTemperature', 'ramUsedGb', 'cpuLoad', 'gpuLoad', 'ip'];
  const themes = ['bars', 'lines', 'large'];

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
    return {
      theme: themes.includes(source.theme) ? source.theme : 'bars',
      traffic: source.traffic !== false,
      ipMode: source.ipMode === 'local' ? 'local' : 'public',
      ipSeconds: Number(source.ipSeconds) === 5 ? 5 : 15
    };
  }

  const api = { metricIds, metricForAction, supportsTraffic, normalize };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.AjazzSettings = api;
})();
