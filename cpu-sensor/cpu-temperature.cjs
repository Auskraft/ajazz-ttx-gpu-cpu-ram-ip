"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");

const SAMPLE_MAX_AGE_MS = 8000;
const READ_INTERVAL_MS = 1500;

function isFanReading(fan) {
  return typeof fan?.id === "string" && fan.id.length > 0 && fan.id.length <= 512 &&
    typeof fan.name === "string" && fan.name.trim() &&
    Number.isFinite(fan.reading) && fan.reading >= 0 && fan.unit === "rpm";
}

function createCpuTemperatureMonitor() {
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  if (!programFiles || !path.isAbsolute(programFiles)) {
    return { snapshot: () => null, fanSnapshot: () => [], close() {} };
  }

  const sensorFile = path.join(programFiles, "Auskraft", "AjazzTTX", "cpu-temperature.json");
  let sample = null;
  let inFlight = false;
  let closed = false;

  async function readSample() {
    if (inFlight || closed) return;
    inFlight = true;
    try {
      const contents = await readFile(sensorFile, "utf8");
      const result = JSON.parse(contents);
      if (closed) return;

      const { cpuTemperature, fans, timestamp } = result;
      const temperature = Number.isFinite(cpuTemperature) && cpuTemperature > 0 && cpuTemperature <= 125
        ? cpuTemperature : null;
      sample = Number.isFinite(timestamp) ? {
        cpuTemperature: temperature,
        fans: Array.isArray(fans) ? fans.filter(isFanReading) : [],
        timestamp,
      } : null;
    } catch {
      sample = null;
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(readSample, READ_INTERVAL_MS);
  timer.unref();
  void readSample();

  function currentSample() {
    if (!sample) return null;
    const age = Date.now() - sample.timestamp;
    return age >= 0 && age <= SAMPLE_MAX_AGE_MS ? sample : null;
  }

  return {
    snapshot() {
      return currentSample()?.cpuTemperature ?? null;
    },
    fanSnapshot() {
      return currentSample()?.fans ?? [];
    },
    close() {
      closed = true;
      clearInterval(timer);
      sample = null;
    }
  };
}

module.exports = { createCpuTemperatureMonitor };
