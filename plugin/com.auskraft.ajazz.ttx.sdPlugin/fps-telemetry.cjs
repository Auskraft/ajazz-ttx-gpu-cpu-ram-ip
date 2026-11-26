"use strict";

const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { normalizeFpsProcess } = require("./settings.js");

const presentMonPath = join(__dirname, "fps-sensor", "PresentMon.exe");
const frameWindowMs = 1200;
const maxFramesPerChain = 1800;
const retryMs = 5000;
const permissionRetryMs = 30000;
const shipProcesses = ["korabli.exe", "korabli64.exe"];

function processNames(target) {
  return target === shipProcesses[0] ? shipProcesses : [target];
}

function createFpsMonitor() {
  const account = process.env.USERDOMAIN + "\\" + process.env.USERNAME;
  const sessionId = createHash("sha256").update(account).digest("hex").slice(0, 12);
  const sessionName = "Auskraft-Ajazz-FPS-" + sessionId;
  const chains = new Map();
  let targets = [];
  let capturedProcesses = new Set();
  let active = null;
  let closed = false;
  let status = "unavailable";
  let retry = null;

  function clearRetry() {
    if (retry) clearTimeout(retry);
    retry = null;
  }

  function collectFrame(line, capture) {
    const columns = line.trim().split(",");
    if (columns[0] === "Application") {
      capture.schema = {
        pid: columns.indexOf("ProcessID"),
        chain: columns.indexOf("SwapChainAddress"),
        duration: columns.indexOf("DisplayedTime")
      };
      return;
    }
    const schema = capture.schema;
    if (!schema || schema.duration < 0) return;
    const executable = columns[0].toLowerCase();
    if (!capturedProcesses.has(executable)) return;
    const duration = Number(columns[schema.duration]);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 5000) return;

    const id = executable + ":" + columns[schema.pid] + ":" + columns[schema.chain];
    let chain = chains.get(id);
    if (!chain) {
      chain = { executable, frames: [] };
      chains.set(id, chain);
    }
    const now = Date.now();
    const frames = chain.frames;
    frames.push({ at: now, duration });
    while (frames.length > maxFramesPerChain || frames[0].at < now - frameWindowMs) frames.shift();
  }

  function start() {
    if (closed || !targets.length || active || retry || process.platform !== "win32" || !existsSync(presentMonPath)) return;

    const processArgs = [...capturedProcesses].flatMap((name) => ["--process_name", name]);
    const child = spawn(presentMonPath, [
      "--session_name", sessionName,
      "--stop_existing_session",
      "--output_stdout",
      "--v2_metrics",
      "--exclude_dropped",
      "--no_console_stats",
      "--no_track_input",
      "--no_track_gpu",
      ...processArgs
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const capture = { child, lines, schema: null, stderr: "", stopping: false, stopTimer: null };
    active = capture;

    lines.on("line", (line) => {
      if (active === capture && !capture.stopping) collectFrame(line, capture);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      capture.stderr = (capture.stderr + chunk).slice(-4096);
      if (/failed to start trace session:\s*access denied/i.test(capture.stderr)) status = "permission";
    });

    child.on("error", () => {});
    child.on("close", () => {
      if (capture.stopTimer) clearTimeout(capture.stopTimer);
      capture.lines.close();
      if (active !== capture) return;
      active = null;
      chains.clear();
      if (closed || !targets.length) return;
      if (capture.stopping) {
        start();
      } else {
        retry = setTimeout(() => {
          retry = null;
          status = "unavailable";
          start();
        }, status === "permission" ? permissionRetryMs : retryMs);
        retry.unref();
      }
    });
  }

  function stop() {
    if (!active || active.stopping) return;
    const capture = active;
    capture.stopping = true;
    const terminate = spawn(presentMonPath, ["--session_name", sessionName, "--terminate_existing_session"], {
      windowsHide: true,
      stdio: "ignore"
    });
    terminate.on("error", () => {});
    capture.stopTimer = setTimeout(() => {
      terminate.kill();
      capture.child.kill();
    }, 1200);
  }

  return {
    setTargets(names) {
      if (closed) return;
      const requested = [...new Set(names.map(normalizeFpsProcess))].sort();
      if (requested.join(",") === targets.join(",")) return;
      targets = requested;
      const requestedProcesses = new Set(targets.flatMap(processNames));
      if (requestedProcesses.size === capturedProcesses.size &&
          [...requestedProcesses].every((executable) => capturedProcesses.has(executable))) return;
      capturedProcesses = requestedProcesses;
      chains.clear();
      status = "unavailable";
      clearRetry();
      if (active) stop();
      else start();
    },

    snapshot() {
      const cutoff = Date.now() - frameWindowMs;
      const recent = new Map();
      for (const [id, chain] of chains) {
        while (chain.frames.length && chain.frames[0].at < cutoff) chain.frames.shift();
        if (!chain.frames.length) {
          chains.delete(id);
          continue;
        }
        if (chain.frames.length > (recent.get(chain.executable)?.length || 0)) {
          recent.set(chain.executable, chain.frames);
        }
      }
      const readings = {};
      for (const target of targets) {
        const best = processNames(target).map((executable) => recent.get(executable))
          .reduce((first, second) => (second?.length || 0) > (first?.length || 0) ? second : first, null);
        if (!best) {
          readings[target] = { fps: null, frameMs: null, status };
          continue;
        }
        const frameMs = best.reduce((sum, frame) => sum + frame.duration, 0) / best.length;
        readings[target] = { fps: 1000 / frameMs, frameMs, status: "ready" };
      }
      return readings;
    },

    close() {
      closed = true;
      targets = [];
      capturedProcesses.clear();
      chains.clear();
      clearRetry();
      stop();
    }
  };
}

module.exports = { createFpsMonitor };
