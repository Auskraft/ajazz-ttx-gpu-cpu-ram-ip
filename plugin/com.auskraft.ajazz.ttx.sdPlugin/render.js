"use strict";

const SIZE = 64;
const GRAPH = { left: 6, right: 58, bottom: 57 };
const CENTER = SIZE / 2;
const FONT = "Segoe UI,Arial,sans-serif";
const MONO = "Consolas,monospace";
const CATEGORIES = { cpu: "#ff777f", gpu: "#8aef66", ram: "#79baff", ip: "#7bcafa" };
const TRAFFIC = [[101, 241, 124], [255, 222, 87], [255, 83, 99]];
const THEMES = {
  bars: { start: "#080a0e", end: "#12151b", primary: "#f4f7fc", secondary: "#c3cad6", grid: "#3f444c" },
  lines: { start: "#071318", end: "#0c2028", primary: "#f4fafc", secondary: "#b4cacf", grid: "#365059" },
  large: { start: "#080a0e", end: "#12151b", primary: "#ffffff", secondary: "#d0d6e0", grid: "#3f444c" }
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
    return width + 0.64;
  }, 0);
}

function fittingSize(value, font, preferred, width) {
  return Math.max(1, Math.min(preferred, Math.floor(width / widthEm(value, font))));
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
  const coords = points.map((pair) => pair.join(",")).join(" ");
  const firstX = points[0][0];
  const [lastX, lastY] = points.at(-1);
  const stops = traffic && metric.limits && points.length > 1
    ? values.map((value, i) => `<stop offset="${(i / (values.length - 1)).toFixed(5)}" stop-color="${colorFor(value)}"/>`).join("")
    : "";
  const gradient = stops ? `<defs><linearGradient id="history" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient></defs>` : "";
  const lineColor = stops ? "url(#history)" : colorFor(values.at(-1));
  const area = theme === "lines" && points.length > 1
    ? `<polygon points="${coords} ${lastX},${bottom + 1} ${firstX},${bottom + 1}" fill="${lineColor}" opacity=".22"/>`
    : "";
  const line = `<polyline points="${coords}" fill="none" stroke="${lineColor}" stroke-width="${theme === "lines" ? 1.35 : 1}" stroke-linejoin="round"/>`;
  const dot = theme === "lines" || points.length === 1
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
  if (!showProgress) return header + address;
  const interval = settings.ipSeconds === 5 ? 5 : 15;
  const remaining = Number.isFinite(ipSecondsRemaining) ? clamp(ipSecondsRemaining, 0, interval) : 0;
  const track = rect(6, 54, 52, 3, palette.grid);
  const progress = rect(6, 54, (52 * remaining / interval).toFixed(2), 3, CATEGORIES.ip);
  return header + address + track + progress;
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
  const font = theme === "bars" ? MONO : FONT;
  if (focus) return drawLargeValue(reading, hasValue ? (memory ? "ГБ" : metric.unit) : "", palette, font);
  const suffix = hasValue ? (memory ? (totalMemory ? "/" + Math.round(totalMemory) : "") : metric.unit) : "";
  const label = text(metric.label, 6, 13, { size: 9, fill: color });
  const defaultSize = memory && String(reading).length > 4 ? 17 :
    (memory && theme === "bars" ? 19 : (large && !memory ? 26 : 22));
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

function renderSvg({ metric, history = [], value, settings = {}, snapshot = {}, focus = false, ipSecondsRemaining }) {
  const theme = Object.hasOwn(THEMES, settings.theme) ? settings.theme : "bars";
  const preferences = { ...settings, theme };
  const palette = THEMES[theme];
  const definition = Object.hasOwn(METRICS, metric) ? METRICS[metric] : null;
  const background = `<defs><linearGradient id="face" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${palette.start}"/><stop offset="1" stop-color="${palette.end}"/></linearGradient></defs><rect width="64" height="64" rx="3" fill="url(#face)"/>`;
  let content = "";
  if (metric === "ip") content = drawIp(value, preferences, palette, focus, ipSecondsRemaining);
  else if (definition) content = drawReading(definition, value, history, preferences, snapshot, focus);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${background}${content}</svg>`;
}

function renderTile(input) {
  return "data:image/svg+xml;charset=utf8," + encodeURIComponent(renderSvg(input));
}

module.exports = { renderSvg, renderTile, METRICS };
