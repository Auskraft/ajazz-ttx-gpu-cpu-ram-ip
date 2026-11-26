"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const GIB = 1024 ** 3;
const SAMPLE_INTERVAL_MS = 1000;
const GPU_TIMEOUT_MS = 8000;
const GPU_RESTART_DELAY_MS = 10000;

function cpuTimes() {
  let idle = 0;
  let total = 0;

  for (const { times } of os.cpus()) {
    idle += times.idle;
    total += times.idle + times.user + times.nice + times.sys + times.irq;
  }

  return { idle, total };
}

function calculateCpuLoad(previous, current) {
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
  return (1 - idle / elapsed) * 100;
}

function memoryUsage() {
  const total = os.totalmem();
  const used = total - os.freemem();

  return {
    ramUsedGb: total > 0 ? Math.max(0, Math.min(used, total)) / GIB : null,
    ramTotalGb: total > 0 ? total / GIB : null,
  };
}

function nvidiaSmiExecutable() {
  const windows = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  const candidates = [
    path.join(windows, "Sysnative", "nvidia-smi.exe"),
    path.join(windows, "System32", "nvidia-smi.exe"),
  ];
  if (programFiles) {
    candidates.push(path.join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
  }
  return candidates.find(existsSync) || "nvidia-smi.exe";
}

function numericField(text) {
  if (!text || !text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseGpuSample(line) {
  const fields = line.split(",");
  if (fields.length !== 2) return null;
  const load = numericField(fields[0]);
  const temperature = numericField(fields[1]);
  if (load === null && temperature === null) return null;

  return {
    gpuLoad: load !== null && load >= 0 && load <= 100 ? load : null,
    gpuTemperature: temperature,
  };
}

function createGpuMonitor() {
  let processState = null;
  let nextLaunchTime = 0;
  let closed = false;
  let sample = null;

  function end(state) {
    if (processState !== state) return;
    processState = null;
    sample = null;
    nextLaunchTime = Date.now() + GPU_RESTART_DELAY_MS;
    state.reader.close();
  }

  function start(now) {
    const child = spawn(nvidiaSmiExecutable(), [
      "--id=0",
      "--query-gpu=utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
      "--loop-ms=" + SAMPLE_INTERVAL_MS,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const state = { child, reader, lastUpdate: now };
    processState = state;

    reader.on("line", (line) => {
      const readings = parseGpuSample(line);
      if (processState !== state || readings === null) return;
      state.lastUpdate = Date.now();
      sample = readings;
    });
    child.on("error", () => end(state));
    child.on("close", () => end(state));
  }

  function refresh() {
    if (closed || process.platform !== "win32") return;

    const now = Date.now();
    if (processState) {
      if (now - processState.lastUpdate < GPU_TIMEOUT_MS) return;
      processState.child.kill();
      end(processState);
    }

    if (now >= nextLaunchTime) start(now);
  }

  return {
    refresh,
    snapshot() {
      return sample || { gpuLoad: null, gpuTemperature: null };
    },
    close() {
      closed = true;
      if (processState) {
        processState.child.kill();
        end(processState);
      }
    },
  };
}

function createCpuTemperatureMonitor() {
  const providerPath = path.join(__dirname, "cpu-temperature.cjs");
  if (!existsSync(providerPath)) return null;
  return require(providerPath).createCpuTemperatureMonitor();
}

function createTelemetry() {
  const gpu = createGpuMonitor();
  const cpuTemperature = createCpuTemperatureMonitor();
  let previousCpuTimes = cpuTimes();
  let cpuLoad = null;
  let memory = memoryUsage();

  function refresh() {
    const currentCpuTimes = cpuTimes();
    cpuLoad = calculateCpuLoad(previousCpuTimes, currentCpuTimes);
    previousCpuTimes = currentCpuTimes;
    memory = memoryUsage();
    gpu.refresh();
  }

  gpu.refresh();
  const interval = setInterval(refresh, SAMPLE_INTERVAL_MS);

  return {
    snapshot() {
      return {
        cpuLoad,
        cpuTemperature: cpuTemperature?.snapshot() ?? null,
        ...gpu.snapshot(),
        ...memory,
      };
    },
    close() {
      clearInterval(interval);
      gpu.close();
      cpuTemperature?.close();
    },
  };
}

module.exports = { createTelemetry };
