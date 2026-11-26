"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SIZE = 64;
const GRAPH = { left: 6, right: 58, bottom: 57 };
const CENTER = SIZE / 2;
const FONT = "Segoe UI,Arial,sans-serif";
const MONO = "Consolas,monospace";
const CATEGORIES = {
  cpu: "#ff777f", gpu: "#8aef66", ram: "#79baff", ip: "#7bcafa",
  fps: "#65efbb", mic: "#ffc473", network: "#78c7ff", ssd: "#b299ff", hdd: "#e8c879", audio: "#87e2d5",
  camera: "#aebaff"
};
const SIGNAL = { green: "#79ef87", amber: "#ffcd69", red: "#ff6777" };
const TRAFFIC = [[101, 241, 124], [255, 222, 87], [255, 83, 99]];
const flags = new Map();
let bitwardenMark;
const THEMES = {
  bars: { start: "#080a0e", end: "#12151b", primary: "#f4f7fc", secondary: "#c3cad6", grid: "#3f444c" },
  lines: { start: "#071318", end: "#0c2028", primary: "#f4fafc", secondary: "#b4cacf", grid: "#365059" },
  large: { start: "#080a0e", end: "#12151b", primary: "#ffffff", secondary: "#d0d6e0", grid: "#3f444c" },
  amber: { start: "#201509", end: "#39260e", primary: "#fff1ce", secondary: "#e8c990", grid: "#765326", outline: "#936b34" },
  ice: { start: "#081929", end: "#142d47", primary: "#eef9ff", secondary: "#bdd8ef", grid: "#436580", outline: "#4578a5" }
};
const METRICS = {
  cpuTemperature: { label: "CPU °C", group: "cpu", unit: "°C", limits: [60, 75, 90] },
  gpuTemperature: { label: "GPU °C", group: "gpu", unit: "°C", limits: [50, 65, 85] },
  gpuHotspot: { label: "GPU HOT", group: "gpu", unit: "°C", limits: [65, 80, 100] },
  ramUsedGb: { label: "RAM ГБ", group: "ram", unit: "GB" },
  cpuLoad: { label: "CPU %", group: "cpu", unit: "%", limits: [0, 50, 100] },
  gpuLoad: { label: "GPU %", group: "gpu", unit: "%", limits: [0, 50, 100] },
  ip: { label: "ВНЕШНИЙ IP", group: "ip" }
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function text(textValue, x, y, { font = FONT, size, fill, anchor = "start" }) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" font-weight="700" text-anchor="${anchor}">${escapeXml(textValue)}</text>`;
}

function rect(x, y, width, height, fill, opacity = 1) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" opacity="${opacity}"/>`;
}

function widthEm(value, font) {
  const characters = String(value);
  if (font === MONO) return characters.length * 0.58;
  return Array.from(characters).reduce((width, character) => {
    if (character === "%") return width + 0.94;
    if (character === "—") return width + 1;
    if ("/.,° ".includes(character)) return width + 0.35;
    if ("ЖМФЫШЩЮ".includes(character)) return width + 0.96;
    if ("КЛНО".includes(character)) return width + 0.76;
    return width + 0.64;
  }, 0);
}

function fittingSize(value, font, preferred, width) {
  return Math.max(1, Math.min(preferred, Math.floor(width / widthEm(value, font))));
}

function numberFont(theme) {
  return theme === "bars" || theme === "amber" ? MONO : FONT;
}

function trafficColor(value, [low, medium, high]) {
  const upper = value > medium ? 2 : 1;
  const start = upper === 1 ? low : medium;
  const end = upper === 1 ? medium : high;
  const weight = clamp((value - start) / (end - start), 0, 1);
  const from = TRAFFIC[upper - 1];
  const to = TRAFFIC[upper];
  const rgb = from.map((channel, i) => Math.round(channel + (to[i] - channel) * weight));
  return "#" + rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("");
}

function normalize(metric, value, totalMemory) {
  if (metric.group === "ram") return clamp(value / (totalMemory || 32), 0, 1);
  if (metric.unit === "°C") return clamp((value - 25) / (Math.max(95, metric.limits[2]) - 25), 0, 1);
  return clamp(value / 100, 0, 1);
}

function drawGraph(metric, history, { theme, totalMemory, traffic, top }) {
  const palette = THEMES[theme];
  const color = CATEGORIES[metric.group];
  const { left, right, bottom } = GRAPH;
  const width = right - left;
  const colorFor = (value) => traffic && metric.limits ? trafficColor(value, metric.limits) : color;
  const values = history.filter(Number.isFinite).slice(-30);
  const baseline = rect(left, bottom + 1, width, 0.65, palette.grid);
  if (!values.length) return baseline;

  if (theme === "bars") {
    const bars = Array.from({ length: 13 }, (_, i) => {
      const sample = values[Math.round(i * (values.length - 1) / 12)];
      const height = Math.max(2, (bottom - top) * normalize(metric, sample, totalMemory));
      return rect(left + i * 4, (bottom - height).toFixed(2), 2.5, height.toFixed(2),
        colorFor(sample), traffic && metric.limits ? 0.94 : (0.3 + 0.68 * i / 12).toFixed(2));
    });
    return baseline + bars.join("");
  }

  const points = values.map((value, i) => {
    const x = values.length === 1 ? right : left + width * i / (values.length - 1);
    const y = bottom - (bottom - top) * normalize(metric, value, totalMemory);
    return [x.toFixed(2), y.toFixed(2)];
  });
  const coords = points.flatMap(([x, y], i) => theme === "amber" && i > 0
    ? [x + "," + points[i - 1][1], x + "," + y] : [x + "," + y]).join(" ");
  const firstX = points[0][0];
  const [lastX, lastY] = points.at(-1);
  const stops = traffic && metric.limits && points.length > 1
    ? values.map((value, i) => `<stop offset="${(i / (values.length - 1)).toFixed(5)}" stop-color="${colorFor(value)}"/>`).join("")
    : "";
  const gradient = stops ? `<defs><linearGradient id="history" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient></defs>` : "";
  const lineColor = stops ? "url(#history)" : colorFor(values.at(-1));
  const filled = theme === "lines" || theme === "ice";
  const area = filled && points.length > 1
    ? `<polygon points="${coords} ${lastX},${bottom + 1} ${firstX},${bottom + 1}" fill="${lineColor}" opacity="${theme === "ice" ? ".34" : ".22"}"/>`
    : "";
  const line = `<polyline points="${coords}" fill="none" stroke="${lineColor}" stroke-width="${filled ? 1.35 : 1}" stroke-linejoin="round"/>`;
  const dot = filled || points.length === 1
    ? `<circle cx="${lastX}" cy="${lastY}" r="1.4" fill="${colorFor(values.at(-1))}"/>`
    : "";
  return baseline + gradient + area + line + dot;
}

function fitAddress(rows, preferred, width, height) {
  const widest = rows.reduce((first, next) => first.length >= next.length ? first : next);
  const verticalLimit = Math.floor(height / ((rows.length - 1) * 1.05 + 0.76));
  const size = fittingSize(widest, MONO, Math.min(preferred, verticalLimit), width);
  return { rows, size };
}

function getFlag(country) {
  if (typeof country !== "string" || !/^[a-z]{2}$/i.test(country)) return null;
  const code = country.toLowerCase();
  if (flags.has(code)) return flags.get(code);
  let flag = null;
  try {
    const image = readFileSync(join(__dirname, "flags", code + ".png"));
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);
    if (width && height) flag = { width, height, data: image.toString("base64") };
  } catch {
    // An unavailable flag leaves the address visible.
  }
  flags.set(code, flag);
  return flag;
}

function drawIpProgress(settings, palette, focus, ipSecondsRemaining) {
  if (focus || settings.ipProgress !== true) return "";
  const interval = settings.ipSeconds === 5 ? 5 : 15;
  const remaining = Number.isFinite(ipSecondsRemaining) ? clamp(ipSecondsRemaining, 0, interval) : 0;
  const track = rect(6, 54, 52, 3, palette.grid);
  return track + rect(6, 54, (52 * remaining / interval).toFixed(2), 3, CATEGORIES.ip);
}

function drawFlag(flag, showProgress) {
  const scale = Math.min(54 / flag.width, 43 / flag.height);
  const width = flag.width * scale;
  const height = flag.height * scale;
  const x = CENTER - width / 2;
  const y = (showProgress ? 27.5 : CENTER) - height / 2;
  return `<image x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" xlink:href="data:image/png;base64,${flag.data}"/>`;
}

function drawIp(value, settings, palette, focus, ipSecondsRemaining) {
  const isLocal = settings.ipMode === "local";
  const label = isLocal ? "ЛОКАЛЬНЫЙ IP" : METRICS.ip.label;
  const parts = typeof value === "string" ? value.split(".") : [];
  const ipv4 = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const ipv6 = typeof value === "string" && value.includes(":") && /^[0-9a-f:.]{2,45}$/i.test(value);
  let rows = ["—"];
  if (ipv4) rows = [parts.slice(0, 2).join(".") + ".", parts.slice(2).join(".")];
  if (ipv6) rows = value.match(/.{1,12}/g);
  const header = focus ? "" : text(label, CENTER, 13, { size: isLocal ? 7 : 8, fill: palette.secondary, anchor: "middle" });
  const showProgress = !focus && settings.ipProgress === true;
  const preferred = focus ? 36 : settings.digitSize ?? 13;
  let layout = fitAddress(rows, preferred, focus ? 58 : 54, focus ? 56 : (showProgress ? 31 : 39));
  if (focus && ipv4) {
    const octets = parts.map((part, index) => index === parts.length - 1 ? part : part + ".");
    const stacked = fitAddress(octets, preferred, 58, 56);
    if (stacked.size >= layout.size + 3) layout = stacked;
  }
  const rowHeight = layout.size * 1.05;
  const middle = focus ? CENTER : (showProgress ? 33 : 39);
  const firstBaseline = middle + layout.size * 0.35 - (layout.rows.length - 1) * rowHeight / 2;
  const address = layout.rows.map((part, i) => text(part, CENTER, (firstBaseline + i * rowHeight).toFixed(2), {
    font: MONO, size: layout.size, fill: palette.primary, anchor: "middle"
  })).join("");
  return header + address + drawIpProgress(settings, palette, focus, ipSecondsRemaining);
}

function drawLargeValue(reading, suffix, palette, font) {
  const gap = suffix ? 1.5 : 0;
  const proportionalUnit = 0.41;
  const totalEm = widthEm(reading, font) + widthEm(suffix, FONT) * proportionalUnit;
  const size = Math.min(42, Math.floor((58 - gap) / totalEm));
  const unitSize = Math.max(6, Math.round(size * proportionalUnit));
  const width = widthEm(reading, font) * size + gap + widthEm(suffix, FONT) * unitSize;
  const x = CENTER - width / 2;
  const y = CENTER + size * 0.36;
  const digits = text(reading, suffix ? x.toFixed(2) : CENTER, y.toFixed(2), {
    font, size, fill: palette.primary, anchor: suffix ? "start" : "middle"
  });
  const unit = suffix ? text(suffix, (SIZE - x).toFixed(2), y.toFixed(2), {
    size: unitSize, fill: palette.primary, anchor: "end"
  }) : "";
  return digits + unit;
}

function drawReading(metric, value, history, settings, snapshot, focus) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const color = CATEGORIES[metric.group];
  const large = theme === "large";
  const memory = metric.group === "ram";
  const totalMemory = Number.isFinite(snapshot.ramTotalGb) && snapshot.ramTotalGb > 0 ? snapshot.ramTotalGb : null;
  const hasValue = Number.isFinite(value);
  const reading = hasValue ? (memory ? value.toFixed(1).replace(".", ",") : Math.round(value)) : "—";
  const font = numberFont(theme);
  if (focus) return drawLargeValue(reading, hasValue ? (memory ? "ГБ" : metric.unit) : "", palette, font);
  const suffix = hasValue ? (memory ? (totalMemory ? "/" + Math.round(totalMemory) : "") : metric.unit) : "";
  const label = text(metric.label, 6, 13, { size: 9, fill: color });
  const defaultSize = memory && String(reading).length > 4 ? 17 :
    (memory && font === MONO ? 19 : (large && !memory ? 26 : 22));
  const unitWidth = suffix ? widthEm(suffix, FONT) * 8 + 2 : 0;
  const preferred = settings.digitSize ?? defaultSize;
  const inlineSize = fittingSize(reading, font, preferred, 53.5 - unitWidth);
  const fullSize = fittingSize(reading, font, preferred, 53.5);
  const separateUnit = settings.digitSize != null && fullSize > inlineSize;
  const fontSize = separateUnit ? fullSize : inlineSize;
  const marker = theme === "bars" && !(memory && suffix && separateUnit) ? rect(54, 7, 3, 3, color) : "";
  const y = large ? 40 : Math.max(35, Math.ceil(14 + fontSize * 0.73));
  const digits = text(reading, 5.5, y, { size: fontSize, fill: palette.primary, font });
  const unitOptions = { size: 8, fill: palette.secondary, anchor: "end" };
  const unit = suffix && !separateUnit ? text(suffix, 59, y - 1, unitOptions) :
    (suffix && memory ? text(suffix, 59, 13, unitOptions) : "");
  const graph = drawGraph(metric, history, { theme, totalMemory, traffic: settings.traffic !== false, top: large ? 47 : Math.max(38, y + 3) });
  return label + marker + digits + unit + graph;
}

function gameHeader(label, color, theme, marker = color) {
  return text(label, 6, 12, { size: 8.4, fill: color }) +
    (theme === "bars" && marker ? rect(54, 7, 3, 3, marker) : "");
}

function gameValue(value, unit, theme, settings, { baseline, preferred, color }) {
  const palette = THEMES[theme];
  const font = numberFont(theme);
  const room = unit ? 51 - widthEm(unit, FONT) * 7.5 : 53;
  const heightLimit = Math.floor((baseline - 14) / 0.73);
  const size = fittingSize(value, font, Math.min(settings.digitSize ?? preferred, heightLimit), room);
  return text(value, 5.5, baseline, { size, font, fill: color ?? palette.primary }) +
    (unit ? text(unit, 58, baseline - 1, { size: 7.5, fill: palette.secondary, anchor: "end" }) : "");
}

function gameGraph(group, measurements, theme, top, maximum) {
  const scale = (sample) => Number.isFinite(sample) ? clamp(sample / maximum, 0, 1) * 100 : 0;
  return drawGraph({ group, unit: "%" }, measurements.map(scale), {
    theme, totalMemory: null, traffic: false, top
  });
}

function decimal(value) {
  return value.toFixed(1).replace(".", ",");
}

function drawFps(value, history, settings, focus, status) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const fps = Number.isFinite(value?.fps) ? Math.round(value.fps) : "—";
  if (focus) return drawLargeValue(fps, fps === "—" ? "" : "FPS", palette, numberFont(theme));
  const header = gameHeader("FPS", CATEGORIES.fps, theme);
  const amount = gameValue(fps, "", theme, settings, { baseline: theme === "large" ? 36 : 33, preferred: theme === "large" ? 28 : 24 });
  const frame = Number.isFinite(value?.frameMs) ? decimal(value.frameMs) + " мс" : "";
  const note = frame || (status === "permission" ? "Доступ к FPS" :
    settings.fpsProcess === "auto" ? "Нет кадров" : "Ожидание игры");
  const detail = text(note, 6, 44, { size: 7.6, fill: status === "permission" ? SIGNAL.amber : palette.secondary });
  const samples = history.map((sample) => Number.isFinite(sample) ? sample : sample?.frameMs);
  return header + amount + detail + gameGraph("fps", samples, theme, 47, 24);
}

function meterColor(level) {
  if (level > -6) return SIGNAL.red;
  if (level > -18) return SIGNAL.amber;
  return SIGNAL.green;
}

function deviceHeader(label, color, enabled, animationPhase) {
  const phase = Number.isFinite(animationPhase) ? animationPhase : 0;
  const opacity = (0.7 + 0.3 * Math.cos(phase * 2 * Math.PI / 16)).toFixed(2);
  const marker = enabled
    ? `<circle cx="57" cy="8.8" r="3.8" fill="${SIGNAL.red}" opacity="${(Number(opacity) * 0.23).toFixed(2)}"/><circle cx="57" cy="8.8" r="2.3" fill="${SIGNAL.red}" opacity="${opacity}"/>`
    : "";
  return text(label, 6, 12, { size: fittingSize(label, FONT, 8.1, 45), fill: color }) + marker;
}

function drawMicrophone(value, settings, animationPhase) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const muted = value?.muted === true;
  const db = Number.isFinite(value?.db) ? clamp(value.db, -60, 0) : null;
  const signal = !muted && db !== null;
  const color = muted ? SIGNAL.red : CATEGORIES.mic;
  const header = deviceHeader("МИКРОФОН", color, value?.muted === false, animationPhase);
  const level = muted ? "ВЫКЛ" : value ? (db === null ? "−∞" : String(Math.round(db)).replace("-", "−")) : "—";
  const readout = gameValue(level, "", theme, settings, {
    baseline: 37, preferred: muted ? 17 : theme === "large" ? 28 : 24, color: muted ? SIGNAL.red : palette.primary
  });
  const count = theme === "lines" ? 26 : 13;
  const stride = 52 / count;
  const height = theme === "large" ? 8 : 7;
  const meter = Array.from({ length: count }, (_, index) => {
    const threshold = -60 + 60 * (index + 1) / count;
    return rect(6 + stride * index, 41, theme === "lines" ? stride : stride - 1, height,
      signal && db >= threshold ? meterColor(threshold) : palette.grid);
  }).join("");
  const ticks = text("−60", 6, 55, { font: MONO, size: 6.6, fill: palette.secondary }) +
    text("−30", CENTER, 55, { font: MONO, size: 6.6, fill: palette.secondary, anchor: "middle" }) +
    text("0", 58, 55, { font: MONO, size: 6.6, fill: palette.secondary, anchor: "end" }) +
    text("dBFS", 58, 61, { size: 5.7, fill: palette.secondary, anchor: "end" });
  return header + readout + meter + ticks;
}

function metricRow(label, value, y, palette, accent = palette.primary) {
  return text(label, 6, y, { size: 7.3, fill: palette.secondary }) +
    text(value, 58, y, { size: 8, fill: accent, anchor: "end" });
}

function drawNetwork(value, settings, focus) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const ping = Number.isFinite(value?.pingMs) ? Math.round(value.pingMs) : "—";
  const loss = Number.isFinite(value?.lossPct) ? Math.round(value.lossPct) : null;
  const jitter = Number.isFinite(value?.jitterMs) ? Math.round(value.jitterMs) : null;
  if (focus) return drawLargeValue(ping, ping === "—" ? "" : "мс", palette, numberFont(theme));
  const accent = loss > 0 || (ping !== "—" && ping > 75) ? SIGNAL.amber : CATEGORIES.network;
  const header = gameHeader("СЕТЬ", CATEGORIES.network, theme, accent);
  const number = gameValue(ping, "мс", theme, settings, { baseline: 30, preferred: 20, color: accent });
  const lossRow = metricRow("Потери", loss === null ? "—" : loss + "%", 39.5, palette, loss > 0 ? SIGNAL.red : palette.primary);
  const jitterRow = metricRow("Джиттер", jitter === null ? "—" : jitter + " мс", 49, palette);
  const graph = gameGraph("network", value?.history ?? [], theme, 52, 135);
  return header + number + lossRow + jitterRow + graph;
}

function drawDisk(value, settings, focus) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const letter = value?.letter || settings.volumeLetter || "C";
  const type = value?.type || "ДИСК";
  const color = type === "SSD" ? CATEGORIES.ssd : CATEGORIES.hdd;
  const free = Number.isFinite(value?.freePct) ? Math.round(clamp(value.freePct, 0, 100)) : "—";
  if (focus) return drawLargeValue(free, free === "—" ? "" : "%", palette, numberFont(theme));
  const tone = free === "—" ? palette.primary : free <= 10 ? SIGNAL.red : free <= 25 ? SIGNAL.amber : palette.primary;
  const header = gameHeader(type + "  " + letter + ":", color, theme);
  const number = gameValue(free, "%", theme, settings, { baseline: 33, preferred: theme === "large" ? 28 : 24, color: tone });
  const detail = text("СВОБОДНО", 6, 43, { size: 7, fill: palette.secondary });
  const used = Number.isFinite(value?.usedGb) ? Math.round(value.usedGb) + " ГБ занято" : "Том недоступен";
  const capacity = text(used, 6, 53, { size: fittingSize(used, FONT, 7.7, 52), fill: palette.primary });
  const track = rect(6, 57, 52, 3, palette.grid);
  const filled = free === "—" ? "" : rect(6, 57, (52 * (1 - free / 100)).toFixed(1), 3, color);
  return header + number + detail + capacity + track + filled;
}

function drawAudioOutput(value, settings, status) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const accent = CATEGORIES.audio;
  const volume = settings.audioShowVolume && Number.isFinite(value?.volumePercent)
    ? Math.round(clamp(value.volumePercent, 0, 100)) + "%" : null;
  const marker = volume ? null : value?.slot ? accent : palette.grid;
  const header = gameHeader("АУДИО", accent, theme, marker) +
    (volume ? text(volume, 58, 12, { font: MONO, size: 7.6, fill: palette.primary, anchor: "end" }) : "");
  if (!value?.configured) {
    const hint = status === "unavailable" ? ["Нет", "выходов"] : ["Выбери", "2 выхода"];
    return header + text(hint[0], 6, 32, { size: 11, fill: palette.primary }) +
      text(hint[1], 6, 47, { size: 10, fill: palette.secondary });
  }

  const name = value.name?.split(" (")[0].trim() || "—";
  const preferred = theme === "large" ? 15 : 13;
  const font = numberFont(theme);
  const words = name.split(/\s+/);
  const lines = words.length > 1 && fittingSize(name, font, preferred, 52) < 9
    ? [words[0], words.slice(1).join(" ")] : [name];
  const readout = lines.map((line, index) => {
    const shortened = Array.from(line).length > 14 ? Array.from(line).slice(0, 13).join("") + "…" : line;
    return text(shortened, 6, lines.length === 1 ? 37 : 30 + 13 * index,
      { font, size: fittingSize(shortened, font, preferred, 52), fill: palette.primary });
  }).join("");
  const slots = [1, 2].map((slot, index) => {
    const active = value.slot === slot;
    const x = 6 + index * 27;
    return rect(x, 48, 25, theme === "lines" ? 1 : 3, active ? accent : palette.grid) +
      text(slot, x + 12.5, 60, { size: 7, font: MONO, fill: active ? accent : palette.secondary, anchor: "middle" });
  }).join("");
  return header + readout + slots;
}

function drawCamera(value, settings, animationPhase) {
  const { theme } = settings;
  const palette = THEMES[theme];
  const enabled = value?.enabled === true;
  const disabled = value?.enabled === false;
  const switching = value?.switching === true;
  const header = deviceHeader("КАМЕРА", CATEGORIES.camera, enabled && !switching, animationPhase);
  const reading = switching ? "…" : enabled ? "ВКЛ" : disabled ? "ВЫКЛ" : "—";
  const displayName = (value?.name || "").split(/\s+/).slice(0, 2).join(" ").slice(0, 22);
  const detail = switching ? "Запрос Windows" : value?.selectionRequired ? "Выбери камеру" :
    (!enabled && !disabled ? "Недоступна" : displayName);
  const color = disabled ? palette.secondary : palette.primary;
  const readout = gameValue(reading, "", theme, settings, {
    baseline: 37, preferred: theme === "large" ? 28 : 23, color
  });
  const subtitle = text(detail, 6, 54, {
    size: fittingSize(detail, FONT, 8.6, 52), fill: switching ? SIGNAL.amber : palette.secondary
  });
  return header + readout + subtitle;
}

function drawBitwarden() {
  if (bitwardenMark === undefined) {
    bitwardenMark = readFileSync(join(__dirname, "images", "bitwarden-mark.png")).toString("base64");
  }
  const size = SIZE * 0.9;
  const inset = SIZE * 0.05;
  return `<image x="${inset}" y="${inset}" width="${size}" height="${size}" xlink:href="data:image/png;base64,${bitwardenMark}"/>`;
}

function renderSvg({ metric, history = [], value, settings = {}, snapshot = {}, focus = false, ipSecondsRemaining, country, showFlag = false, status, animationPhase }) {
  const theme = metric !== "bitwarden" && Object.hasOwn(THEMES, settings.theme) ? settings.theme : "bars";
  const preferences = { ...settings, theme };
  const palette = THEMES[theme];
  const definition = Object.hasOwn(METRICS, metric) ? METRICS[metric] : null;
  const flag = metric === "ip" && showFlag && !focus && settings.ipMode !== "local" ? getFlag(country) : null;
  const outline = palette.outline ? `<rect x="1" y="1" width="62" height="62" rx="3" fill="none" stroke="${palette.outline}" stroke-width=".8"/>` : "";
  const background = `<defs><linearGradient id="face" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${palette.start}"/><stop offset="1" stop-color="${palette.end}"/></linearGradient></defs><rect width="64" height="64" rx="3" fill="url(#face)"/>` + outline;
  let content = "";
  if (flag) content = drawFlag(flag, preferences.ipProgress === true) + drawIpProgress(preferences, palette, focus, ipSecondsRemaining);
  else if (metric === "ip") content = drawIp(value, preferences, palette, focus, ipSecondsRemaining);
  else if (metric === "fps") content = drawFps(value, history, preferences, focus, status);
  else if (metric === "microphone") content = drawMicrophone(value, preferences, animationPhase);
  else if (metric === "network") content = drawNetwork(value, preferences, focus);
  else if (metric === "disk") content = drawDisk(value, preferences, focus);
  else if (metric === "audioOutput") content = drawAudioOutput(value, preferences, status);
  else if (metric === "camera") content = drawCamera(value, preferences, animationPhase);
  else if (metric === "bitwarden") content = drawBitwarden();
  else if (definition) content = drawReading(definition, value, history, preferences, snapshot, focus);
  const xlink = flag || metric === "bitwarden" ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${background}${content}</svg>`;
}

function renderTile(input) {
  return "data:image/svg+xml;charset=utf8," + encodeURIComponent(renderSvg(input));
}

module.exports = { renderSvg, renderTile, METRICS };
