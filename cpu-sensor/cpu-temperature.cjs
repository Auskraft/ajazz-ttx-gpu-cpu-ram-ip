"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");

const SAMPLE_MAX_AGE_MS = 8000;
const READ_INTERVAL_MS = 1500;

function createCpuTemperatureMonitor() {
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  if (!programFiles || !path.isAbsolute(programFiles)) {
    return { snapshot: () => null, close() {} };
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

      const { cpuTemperature, timestamp } = result;
      sample = Number.isFinite(cpuTemperature) && cpuTemperature > 0 && cpuTemperature <= 125 &&
        Number.isFinite(timestamp) ? { cpuTemperature, timestamp } : null;
    } catch {
      sample = null;
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(readSample, READ_INTERVAL_MS);
  timer.unref();
  void readSample();

  return {
    snapshot() {
      if (!sample) return null;
      const age = Date.now() - sample.timestamp;
      return age >= 0 && age <= SAMPLE_MAX_AGE_MS ? sample.cpuTemperature : null;
    },
    close() {
      closed = true;
      clearInterval(timer);
      sample = null;
    }
  };
}

module.exports = { createCpuTemperatureMonitor };
