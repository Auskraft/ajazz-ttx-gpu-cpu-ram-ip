(function () {
  'use strict';

  const prefix = 'com.auskraft.ajazz.ttx.';
  const hardwareMetricIds = ['cpuTemperature', 'gpuTemperature', 'ramUsedGb', 'cpuLoad', 'gpuLoad', 'gpuPower', 'fanSpeed'];
  const metricIds = [
    ...hardwareMetricIds, 'ip', 'fps', 'microphone', 'network', 'disk', 'bitwarden', 'audioOutput', 'camera',
    'diskActivity', 'networkSpeed', 'topProcess'
  ];
  const themes = ['bars', 'lines', 'large', 'amber', 'ice'];
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

  function normalizeFpsExecutable(value) {
    let name = typeof value === 'string' ? value.trim().replace(/^"(.*)"$/, '$1').toLowerCase() : '';
    if (/^(?:[a-z]:[\\/]|\\\\)/i.test(name)) name = name.split(/[\\/]/).at(-1);
    if (!name || name.endsWith('.') || /^[.-]|[\x00-\x1f\x7f<>:"/\\|?*]/.test(name)) return '';
    const executable = name.endsWith('.exe') ? name : name + '.exe';
    return executable.length <= 255 ? executable : '';
  }

  function normalizeFpsProcess(value) {
    if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') return 'auto';
    return normalizeFpsExecutable(value) || 'auto';
  }

  function normalizePingTarget(value) {
    const target = typeof value === 'string' ? value.trim() : '';
    const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
    const ipv6 = /^(?:[0-9a-f:.]{0,38}:[0-9a-f:.]{0,38})$/i;
    return target.length <= 253 && (hostname.test(target) || ipv6.test(target)) ? target : '1.1.1.1';
  }

  function normalizeDeviceId(value) {
    return typeof value === 'string' && value.length <= 512 && value.trim() && !/[\x00-\x1f\x7f]/.test(value)
      ? value : '';
  }

  function normalizeBitwardenPath(value) {
    const target = typeof value === 'string' ? value.trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\') : '';
    return target.length <= 1024 && /^[a-z]:\\(?:[^<>:"/\\|?*\x00-\x1f\x7f]+\\)*Bitwarden\.exe$/i.test(target)
      ? target : '';
  }

  function normalize(settings) {
    const source = settings ?? {};
    const size = source.digitSize;
    const digitSize = typeof size === 'number' || (typeof size === 'string' && size.trim())
      ? Number(size) : NaN;
    const fpsProcess = normalizeFpsProcess(source.fpsProcess);

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
      fpsProcess,
      fpsManualProcess: fpsProcess === 'auto' ? normalizeFpsExecutable(source.fpsManualProcess) : fpsProcess,
      pingTarget: normalizePingTarget(source.pingTarget),
      audioOutputA: normalizeDeviceId(source.audioOutputA),
      audioOutputB: normalizeDeviceId(source.audioOutputB),
      audioShowVolume: source.audioShowVolume === true,
      cameraId: normalizeDeviceId(source.cameraId),
      bitwardenPath: normalizeBitwardenPath(source.bitwardenPath),
      fanSource: normalizeDeviceId(source.fanSource) || 'auto',
      networkAdapterId: normalizeDeviceId(source.networkAdapterId),
      topProcessMode: source.topProcessMode === 'ram' ? 'ram' : 'cpu',
      indicatorSize: ['small', 'medium', 'large'].includes(source.indicatorSize) ? source.indicatorSize : 'medium',
      volumeLetter: typeof source.volumeLetter === 'string' && /^[a-z]:?$/i.test(source.volumeLetter.trim())
        ? source.volumeLetter.trim()[0].toUpperCase() : 'C'
    };
  }

  const api = {
    metricIds, hardwareMetricIds, metricForAction, supportsTraffic, normalize, normalizeFpsProcess, normalizeFpsExecutable,
    normalizeAudioOutputId: normalizeDeviceId, normalizeCameraId: normalizeDeviceId,
    normalizeFanSourceId: normalizeDeviceId, normalizeNetworkAdapterId: normalizeDeviceId,
    normalizeBitwardenPath, digitSizeRange
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.AjazzSettings = api;
})();
