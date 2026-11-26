'use strict';

const refreshInterval = 30 * 60 * 1000;
const failureInterval = 5 * 60 * 1000;
const requestTimeout = 8000;

const endpoint = new URL('https://api.open-meteo.com/v1/forecast');
endpoint.search = new URLSearchParams({
  latitude: '48.71378',
  longitude: '44.4976',
  current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
  temperature_unit: 'celsius',
  wind_speed_unit: 'kmh',
  timeformat: 'unixtime',
  timezone: 'GMT',
  forecast_days: '1',
});

function parseCurrent(current, fetchedAt) {
  if (!current) return null;
  const {
    temperature_2m: temperature,
    apparent_temperature: feelsLike,
    weather_code: weatherCode,
    is_day: day,
    wind_speed_10m: windSpeed,
    time,
  } = current;
  if (!Number.isFinite(temperature) || !Number.isInteger(weatherCode) || weatherCode < 0 || weatherCode > 99 ||
      (day !== 0 && day !== 1) || !Number.isSafeInteger(time) || time <= 0) return null;

  const observedAt = time * 1000;
  if (observedAt > fetchedAt + refreshInterval) return null;

  return Object.freeze({
    temperature,
    feelsLike: Number.isFinite(feelsLike) ? feelsLike : null,
    weatherCode,
    isDay: day === 1,
    windSpeed: Number.isFinite(windSpeed) && windSpeed >= 0 ? windSpeed : null,
    observedAt,
    fetchedAt,
    stale: fetchedAt - observedAt > refreshInterval,
  });
}

function createWeather() {
  let cached = null;
  let pending = null;
  let nextReadAt = -Infinity;
  let closed = false;

  async function refresh(signal, startedAt) {
    try {
      const response = await fetch(endpoint, { signal, redirect: 'error' });
      if (!response.ok) throw new Error('Open-Meteo returned an unsuccessful status');
      const payload = await response.json();
      const reading = parseCurrent(payload?.current, Date.now());
      if (!reading || (cached && reading.observedAt < cached.observedAt)) {
        throw new Error('Open-Meteo returned invalid current weather');
      }
      if (closed) return null;
      cached = reading;
      nextReadAt = startedAt + (reading.stale ? failureInterval : refreshInterval);
    } catch {
      if (closed) return null;
      if (cached && !cached.stale) cached = Object.freeze({ ...cached, stale: true });
      nextReadAt = startedAt + failureInterval;
    }
    return cached;
  }

  return {
    isDue() {
      return !closed && !pending && Date.now() >= nextReadAt;
    },
    read() {
      if (closed) return Promise.resolve(null);
      if (pending) return pending.result;
      const now = Date.now();
      if (now < nextReadAt) return Promise.resolve(cached);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      timer.unref();
      pending = {
        controller,
        result: refresh(controller.signal, now).finally(() => {
          clearTimeout(timer);
          pending = null;
        }),
      };
      return pending.result;
    },
    close() {
      closed = true;
      cached = null;
      pending?.controller.abort();
    },
  };
}

module.exports = { createWeather };
