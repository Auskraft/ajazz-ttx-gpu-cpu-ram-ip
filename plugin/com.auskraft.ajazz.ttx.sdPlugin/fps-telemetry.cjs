"use strict";

const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { createConnection } = require("node:net");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { normalizeFpsProcess } = require("./settings.js");

const presentMonPath = join(__dirname, "fps-sensor", "PresentMon.exe");
const foregroundPath = join(__dirname, "fps-sensor", "ForegroundProcess.exe");
const autoTarget = "auto";
const frameWindowMs = 1200;
const maxFramesPerChain = 1800;
const retryMs = 5000;
const brokerPipe = "\\\\.\\pipe\\Auskraft-Ajazz-TTX-Fps-v1";
const brokerTask = "Auskraft Ajazz TTX FPS Sensor";
const brokerWaitMs = 9000;
const brokerPollMs = 200;
const shipProcesses = ["korabli.exe", "korabli64.exe"];

function processNames(target) {
  return target === shipProcesses[0] ? shipProcesses : [target];
}

function listFpsApps() {
  if (process.platform !== "win32" || !existsSync(foregroundPath)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile(foregroundPath, ["--apps"], { windowsHide: true, timeout: 4000 }, (error, output) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(output.split(/\r?\n/).filter((name) => /\.exe$/i.test(name)));
    });
  });
}

function createFpsMonitor() {
  const account = process.env.USERDOMAIN + "\\" + process.env.USERNAME;
  const sessionId = createHash("sha256").update(account).digest("hex").slice(0, 12);
  const sessionName = "Auskraft-Ajazz-FPS-" + sessionId;
  const chains = new Map();
  let targets = [];
  let capturedProcesses = new Set();
  let active = null;
  let foreground = null;
  let foregroundPid = null;
  let foregroundNextStart = 0;
  let closed = false;
  let status = "unavailable";
  let retry = null;
  let useBroker = false;
  let brokerBlocked = false;
  let earlyBrokerDisconnects = 0;

  function clearRetry() {
    if (retry) clearTimeout(retry);
    retry = null;
  }

  function monitorForeground() {
    if (foreground || Date.now() < foregroundNextStart ||
        process.platform !== "win32" || !existsSync(foregroundPath)) return;
    const child = spawn(foregroundPath, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const watcher = { child, lines };
    foreground = watcher;
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    lines.on("line", (line) => {
      if (foreground === watcher && /^\d{1,10}$/.test(line)) foregroundPid = Number(line) || null;
    });
    child.on("close", () => {
      lines.close();
      if (foreground !== watcher) return;
      foreground = null;
      foregroundPid = null;
      foregroundNextStart = Date.now() + retryMs;
    });
  }

  function stopForeground() {
    if (!foreground) return;
    const watcher = foreground;
    foreground = null;
    foregroundPid = null;
    watcher.lines.close();
    watcher.child.stdin.end();
  }

  function collectFrame(line, capture) {
    const columns = line.trim().split(",");
    if (columns[0] === "Application") {
      capture.schema = {
        length: columns.length,
        pid: columns.indexOf("ProcessID"),
        chain: columns.indexOf("SwapChainAddress"),
        duration: columns.indexOf("DisplayedTime")
      };
      return;
    }
    const schema = capture.schema;
    if (!schema || schema.pid < 0 || schema.chain < 0 || schema.duration < 0 || columns.length < schema.length) return;
    // PresentMon writes the executable in the first column without escaping commas in the name.
    if (columns.length > schema.length) {
      const name = columns.splice(0, columns.length - schema.length + 1).join(",");
      columns.unshift(name);
    }
    const executable = columns[0].replace(/^"|"$/g, "").toLowerCase();
    const pid = Number(columns[schema.pid]);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (pid !== foregroundPid && !capturedProcesses.has(executable)) return;
    const duration = Number(columns[schema.duration]);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 5000) return;

    const id = executable + ":" + pid + ":" + columns[schema.chain];
    let chain = chains.get(id);
    if (!chain) {
      chain = { executable, pid, frames: [] };
      chains.set(id, chain);
    }
    const now = Date.now();
    const frames = chain.frames;
    frames.push({ at: now, duration });
    while (frames.length > maxFramesPerChain || frames[0].at < now - frameWindowMs) frames.shift();
  }

  function readCapture(input, capture) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    capture.lines = lines;
    lines.on("line", (line) => {
      if (active === capture && !capture.stopping && line.length <= 8192) collectFrame(line, capture);
    });
  }

  function retryCapture() {
    retry = setTimeout(() => {
      retry = null;
      start();
    }, retryMs);
    retry.unref();
  }

  function closeBroker(capture) {
    if (active === capture) active = null;
    clearTimeout(capture.wait);
    clearTimeout(capture.poll);
    capture.task?.kill();
    capture.lines?.close();
    capture.socket?.destroy();
  }

  function startBroker() {
    if (brokerBlocked) return;
    const capture = { kind: "broker", connected: false, taskRequested: false };
    active = capture;

    function fail() {
      if (active !== capture) return;
      closeBroker(capture);
      brokerBlocked = true;
      status = "permission";
    }

    function poll() {
      capture.poll = setTimeout(dial, brokerPollMs);
      capture.poll.unref();
    }

    function launchTask() {
      capture.taskRequested = true;
      const taskHost = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
      const options = { windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 };
      capture.task = execFile(taskHost, ["/Query", "/TN", brokerTask], options, (error) => {
        if (active !== capture) return;
        capture.task = null;
        if (error) {
          fail();
          return;
        }
        capture.task = execFile(taskHost, ["/Run", "/TN", brokerTask], options, () => {
          if (active !== capture) return;
          capture.task = null;
          // An existing task instance may already be starting the pipe.
          poll();
        });
      });
    }

    function dial() {
      if (active !== capture) return;
      const socket = createConnection(brokerPipe);
      capture.socket = socket;
      socket.once("error", () => {});
      socket.once("connect", () => {
        if (active !== capture) return;
        capture.connected = true;
        clearTimeout(capture.wait);
        status = "unavailable";
        readCapture(socket, capture);
      });
      socket.once("close", () => {
        if (active !== capture) return;
        if (!capture.connected) {
          if (capture.taskRequested) poll();
          else launchTask();
          return;
        }
        chains.clear();
        if (capture.schema) earlyBrokerDisconnects = 0;
        else earlyBrokerDisconnects++;
        if (earlyBrokerDisconnects > 1) fail();
        else {
          closeBroker(capture);
          retryCapture();
        }
      });
    }

    capture.wait = setTimeout(fail, brokerWaitMs);
    capture.wait.unref();
    dial();
  }

  function start() {
    if (closed || !targets.length || active || retry || process.platform !== "win32") return;
    if (useBroker) {
      status = "permission";
      startBroker();
      return;
    }
    if (!existsSync(presentMonPath)) return;

    const processArgs = targets.includes(autoTarget) ? [] :
      [...capturedProcesses].flatMap((name) => ["--process_name", name]);
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
    const capture = { kind: "direct", child, schema: null, stderr: "", stopping: false, stopTimer: null, denied: false };
    active = capture;

    readCapture(child.stdout, capture);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      capture.stderr = (capture.stderr + chunk).slice(-4096);
      if (active === capture && /failed to start trace session:\s*access denied/i.test(capture.stderr)) {
        capture.denied = true;
        status = "permission";
      }
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
      } else if (capture.denied) {
        useBroker = true;
        start();
      } else {
        status = "unavailable";
        retryCapture();
      }
    });
  }

  function stop() {
    if (!active || active.stopping) return;
    const capture = active;
    if (capture.kind === "broker") {
      closeBroker(capture);
      return;
    }
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
      if (requested.length === targets.length && requested.every((name, index) => name === targets[index])) return;
      const previousAuto = targets.includes(autoTarget);
      const automatic = requested.includes(autoTarget);
      targets = requested;
      const requestedProcesses = new Set(targets.filter((name) => name !== autoTarget).flatMap(processNames));
      const sameExplicitTargets = requestedProcesses.size === capturedProcesses.size &&
        [...requestedProcesses].every((executable) => capturedProcesses.has(executable));
      capturedProcesses = requestedProcesses;
      if (!targets.length) {
        chains.clear();
        clearRetry();
        stopForeground();
        stop();
        return;
      }
      if (automatic) {
        monitorForeground();
      } else {
        stopForeground();
      }
      if (active?.kind === "broker" || (automatic ? previousAuto : !previousAuto && sameExplicitTargets)) return;
      chains.clear();
      status = "unavailable";
      clearRetry();
      if (active) stop();
      else start();
    },

    snapshot() {
      if (targets.includes(autoTarget)) monitorForeground();
      const cutoff = Date.now() - frameWindowMs;
      const recent = new Map();
      let foregroundFrames = null;
      for (const [id, chain] of chains) {
        while (chain.frames.length && chain.frames[0].at < cutoff) chain.frames.shift();
        if (!chain.frames.length) {
          chains.delete(id);
          continue;
        }
        if (chain.frames.length > (recent.get(chain.executable)?.length || 0)) {
          recent.set(chain.executable, chain.frames);
        }
        if (chain.pid === foregroundPid && chain.frames.length > (foregroundFrames?.length || 0)) {
          foregroundFrames = chain.frames;
        }
      }
      const readings = {};
      for (const target of targets) {
        const dynamic = target === autoTarget;
        const best = dynamic ? foregroundFrames : processNames(target).map((executable) => recent.get(executable))
          .reduce((first, second) => (second?.length || 0) > (first?.length || 0) ? second : first, null);
        const frameMs = best ? best.reduce((sum, frame) => sum + frame.duration, 0) / best.length : null;
        const reading = { fps: frameMs ? 1000 / frameMs : null, frameMs, status: frameMs ? "ready" : status };
        if (dynamic) reading.processId = foregroundPid;
        readings[target] = reading;
      }
      return readings;
    },

    close() {
      closed = true;
      targets = [];
      capturedProcesses.clear();
      chains.clear();
      clearRetry();
      stopForeground();
      stop();
    }
  };
}

module.exports = { createFpsMonitor, listFpsApps };
