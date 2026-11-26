"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const GB = 1e9;
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
    ramUsedGb: total > 0 ? Math.max(0, Math.min(used, total)) / GB : null,
    ramTotalGb: total > 0 ? total / GB : null,
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
  if (fields.length !== 4) return null;
  const load = numericField(fields[0]);
  const temperature = numericField(fields[1]);
  const power = numericField(fields[2]);
  const fan = numericField(fields[3]);
  if (load === null && temperature === null && power === null && fan === null) return null;

  return {
    gpuLoad: load !== null && load >= 0 && load <= 100 ? load : null,
    gpuTemperature: temperature,
    gpuPowerW: power !== null && power >= 0 ? power : null,
    gpuFanPercent: fan !== null && fan >= 0 ? fan : null,
  };
}

function createStreamingMonitor(executable, args, parseSample) {
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
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const state = { child, reader, lastUpdate: now };
    processState = state;

    reader.on("line", (line) => {
      const readings = parseSample(line);
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
    const state = processState;
    if (state) {
      if (now - state.lastUpdate < GPU_TIMEOUT_MS) return;
      end(state);
      state.child.kill();
    }

    if (now >= nextLaunchTime) start(now);
  }

  return {
    refresh,
    snapshot() {
      return sample;
    },
    close() {
      closed = true;
      const state = processState;
      if (state) {
        end(state);
        state.child.kill();
      }
    },
  };
}

function createGpuMonitor() {
  return createStreamingMonitor(nvidiaSmiExecutable(), [
    "--id=0",
    "--query-gpu=utilization.gpu,temperature.gpu,power.draw,fan.speed",
    "--format=csv,noheader,nounits",
    "--loop-ms=" + SAMPLE_INTERVAL_MS,
  ], parseGpuSample);
}

function createGpuHardwareMonitor() {
  const executable = path.join(__dirname, "gpu-sensor", "GpuHotspot.exe");
  if (!existsSync(executable)) return null;
  return createStreamingMonitor(executable, ["--telemetry"], (line) => {
    try {
      const { gpuHotspot, gpuFanRpm } = JSON.parse(line);
      return {
        gpuHotspot: Number.isFinite(gpuHotspot) && gpuHotspot > 0 && gpuHotspot <= 150 ? gpuHotspot : null,
        gpuFanRpm: Number.isFinite(gpuFanRpm) && gpuFanRpm >= 0 ? gpuFanRpm : null,
      };
    } catch {
      return null;
    }
  });
}

function createCpuTemperatureMonitor() {
  const providerPath = path.join(__dirname, "cpu-temperature.cjs");
  if (!existsSync(providerPath)) return null;
  return require(providerPath).createCpuTemperatureMonitor();
}

function createTelemetry() {
  const gpu = createGpuMonitor();
  const cpuTemperature = createCpuTemperatureMonitor();
  let gpuHardware = null;
  let hotspotEnabled = false;
  let gpuPowerEnabled = false;
  let fansEnabled = false;
  let previousCpuTimes = cpuTimes();
  let cpuLoad = null;
  let memory = memoryUsage();

  function refresh() {
    const currentCpuTimes = cpuTimes();
    cpuLoad = calculateCpuLoad(previousCpuTimes, currentCpuTimes);
    previousCpuTimes = currentCpuTimes;
    memory = memoryUsage();
    gpu.refresh();
    gpuHardware?.refresh();
  }

  function syncGpuHardware() {
    if (hotspotEnabled || fansEnabled) {
      if (!gpuHardware) {
        gpuHardware = createGpuHardwareMonitor();
        gpuHardware?.refresh();
      }
    } else if (gpuHardware) {
      gpuHardware.close();
      gpuHardware = null;
    }
  }

  gpu.refresh();
  const interval = setInterval(refresh, SAMPLE_INTERVAL_MS);

  return {
    setGpuHotspotEnabled(enabled) {
      hotspotEnabled = enabled;
      syncGpuHardware();
    },
    setAdditionalSensors({ gpuPower, fanSpeed }) {
      gpuPowerEnabled = gpuPower;
      fansEnabled = fanSpeed;
      syncGpuHardware();
    },
    snapshot() {
      const gpuSample = gpu.snapshot();
      const hardwareSample = gpuHardware?.snapshot();
      const fans = fansEnabled ? [...(cpuTemperature?.fanSnapshot?.() ?? [])] : [];
      if (fansEnabled) {
        const rpm = hardwareSample?.gpuFanRpm;
        const reading = rpm ?? gpuSample?.gpuFanPercent ?? null;
        if (reading !== null) fans.unshift({ id: "gpu", name: "GPU", reading, unit: rpm == null ? "%" : "rpm" });
      }
      return {
        cpuLoad,
        cpuTemperature: cpuTemperature?.snapshot() ?? null,
        gpuLoad: gpuSample?.gpuLoad ?? null,
        gpuTemperature: gpuSample?.gpuTemperature ?? null,
        gpuHotspot: hotspotEnabled ? hardwareSample?.gpuHotspot ?? null : null,
        gpuPowerW: gpuPowerEnabled ? gpuSample?.gpuPowerW ?? null : null,
        fans,
        ...memory,
      };
    },
    close() {
      clearInterval(interval);
      gpu.close();
      gpuHardware?.close();
      cpuTemperature?.close();
    },
  };
}

module.exports = { createTelemetry };
