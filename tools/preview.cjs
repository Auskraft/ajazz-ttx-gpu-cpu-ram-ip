"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { renderSvg } = require("../plugin/com.auskraft.ajazz.ttx.sdPlugin/render.js");

const metrics = ["cpuTemperature", "gpuTemperature", "ramUsedGb", "cpuLoad", "gpuLoad", "ip"];
const gameMetrics = ["fps", "microphone", "network", "disk", "bitwarden", "audioOutput", "camera"];
const systemMetrics = ["gpuPower", "fanSpeed", "diskActivity", "networkSpeed", "topProcess"];
const extraMetrics = ["topGpu", "weather"];
const themes = {
  bars: "Пиксельные столбики",
  lines: "Тонкие линии",
  large: "Цифры крупнее",
  amber: "Янтарный терминал",
  ice: "Ледяной контур"
};
const example = {
  cpuTemperature: [77, [57, 59, 61, 69, 74, 81, 88, 83, 74, 69, 70, 74, 77]],
  gpuTemperature: [67, [48, 50, 53, 57, 62, 70, 81, 79, 74, 68, 65, 65, 67]],
  ramUsedGb: [14.8, [7, 7.5, 7.4, 8, 8, 9, 11, 10.5, 11, 12.8, 14.4, 14.6, 14.8]],
  cpuLoad: [39, [22, 24, 36, 58, 98, 85, 66, 39, 34, 61, 36, 30, 39]],
  gpuLoad: [83, [18, 26, 28, 43, 59, 71, 96, 97, 84, 71, 65, 82, 83]],
  ip: ["203.0.113.42", []],
  fps: [{ fps: 144, frameMs: 6.9 }, [7, 7, 8, 12, 7, 8, 7, 9, 8, 7, 11, 8, 7]],
  microphone: [{ db: -16, muted: false }, []],
  network: [{ pingMs: 24, lossPct: 0, jitterMs: 3, history: [23, 28, 40, 22, 29, 25, 51, 22, 32, 23, 33, 24, 31] }, []],
  disk: [{ letter: "C", type: "SSD", usedGb: 286, totalGb: 447, freePct: 36 }, []],
  bitwarden: [null, []],
  audioOutput: [{ name: "Наушники", slot: 1, configured: true, volumePercent: 62 }, []],
  camera: [{ name: "Logitech C922", enabled: true }, []],
  gpuPower: [87, [49, 53, 69, 71, 88, 95, 92, 84, 83, 90, 87]],
  fanSpeed: [{ name: "GPU", reading: 1795, unit: "rpm" }, [895, 935, 1190, 1294, 1547, 1580, 1725, 1750, 1788, 1795]],
  diskActivity: [{ letter: "C", readBytesPerSecond: 124500000, writeBytesPerSecond: 8200000, activePercent: 47 },
    [4, 21, 48, 27, 35, 49, 76, 132, 126, 124].map((rate) => ({ readBytesPerSecond: rate * 1e6, writeBytesPerSecond: 8e6 }))],
  networkSpeed: [{ receiveBytesPerSecond: 10525000, sendBytesPerSecond: 310000 },
    [18, 24, 37, 51, 81, 90, 79, 68, 91, 84].map((rate) => ({ receiveBytesPerSecond: rate * 125000, sendBytesPerSecond: 310000 }))],
  topProcess: [{ name: "Korabli64", cpuPercent: 28.4 }, []],
  topGpu: [{ name: "Korabli64", gpuPercent: 92.4 }, []],
  weather: [{ temperature: -3.7, feelsLike: -7.1, weatherCode: 71, isDay: true }, []]
};

function tile(metric, theme, focus = false, extra = {}, suffix = "") {
  const [exampleValue, history] = example[metric];
  const value = focus && metric === "cpuLoad" ? 18 : exampleValue;
  const key = (focus ? "focus-" + metric : theme + "-" + metric) + suffix;
  const { settings, ...overrides } = extra;
  return renderSvg({
    metric, value, history, focus, status: metric === "fps" ? "ready" : undefined,
    settings: { theme, traffic: true, ipSeconds: 15, audioShowVolume: true, ...settings },
    snapshot: { ramTotalGb: 32 }, ...overrides
  }).replaceAll('id="face"', `id="face-${key}"`)
    .replaceAll("#face)", `#face-${key})`)
    .replaceAll('id="history"', `id="history-${key}"`)
    .replaceAll("#history)", `#history-${key})`);
}

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="13" fill="#111722"/>
  <rect x="10" y="10" width="44" height="44" rx="9" fill="#1a2231" stroke="#42516a"/>
  <path d="M20 43V33M26 43V28M32 43V20M38 43V25M44 43V35" fill="none" stroke="#79baff" stroke-width="4" stroke-linecap="round"/>
  <circle cx="32" cy="20" r="2" fill="#d3edff"/>
</svg>`;

function html(body, style) {
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + style + '</style>' + body + '</html>';
}

const target = process.argv[2];
if (!target) throw new Error("Pass a temporary preview directory.");
fs.mkdirSync(target, { recursive: true });
const sheet = [logo, logo, ...[...metrics, ...gameMetrics, ...systemMetrics, ...extraMetrics].map((metric) => tile(metric, "bars"))];
fs.writeFileSync(path.join(target, "icons.html"), html("<main>" + sheet.join("") + "</main>",
  "html,body{margin:0}main{display:grid;grid-template-columns:repeat(4,128px);width:512px}svg{display:block;width:128px;height:128px}"));

const variants = Object.entries(themes).map(([theme, name]) =>
  `<section><h2>${name}</h2><div class="device">${metrics.map((metric) => tile(metric, theme)).join("")}</div></section>`);
const gamingVariants = Object.entries(themes).map(([theme, name]) => {
  const tiles = gameMetrics.slice(0, 4).map((metric) => tile(metric, theme));
  const audio = theme === "lines" ? { name: "Динамики", slot: 2, configured: true, volumePercent: 45 } : example.audioOutput[0];
  tiles.push(tile("audioOutput", theme, false, { value: audio }), tile("bitwarden", theme));
  return `<section><h2>${name}</h2><div class="device">${tiles.join("")}</div></section>`;
});
const systemVariants = Object.entries(themes).map(([theme, name]) => {
  const tiles = systemMetrics.map((metric) => tile(metric, theme));
  tiles.push(tile("topProcess", theme, false, {
    value: { name: "Korabli64", memoryBytes: 3070901617 }, settings: { topProcessMode: "ram" }
  }, "-ram"));
  return `<section><h2>${name}</h2><div class="device">${tiles.join("")}</div></section>`;
});
fs.writeFileSync(path.join(target, "themes.html"), html(`
  <main>
    <header><div><p>AJAZZ AKP03R</p><h1>Мониторинг ПК</h1></div><span>Демонстрационные данные</span></header>
    <div class="themes">${variants.join("")}</div>
    <footer><span class="cpu">CPU</span><span class="gpu">GPU</span><span class="ram">RAM</span><span class="ip">IP</span><span class="gradient">Цвет графика меняется по значению</span></footer>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:37px 40px;width:1390px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:35px}
  header p,h1,h2{margin:0}header p{font-size:13px;font-weight:650;letter-spacing:.11em;color:#9eb1c8}
  h1{font-size:37px;line-height:1.18;letter-spacing:-.035em;margin-top:5px}header span{font-size:13px;color:#a9b6c9}
  .themes{display:grid;grid-template-columns:repeat(5,1fr);gap:20px}h2{font-size:16px;font-weight:600;margin-bottom:12px}
  .device{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px;border:1px solid #424b5b;border-radius:17px;background:#252d39;box-shadow:0 7px 14px #03070c66}
  svg{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
  footer{display:flex;gap:16px;margin-top:27px;align-items:center;font-size:13px;font-weight:650;color:#a9b6c9}
  .cpu{color:#ff777f}.gpu{color:#8aef66}.ram{color:#79baff}.ip{color:#7bcafa}.gradient{margin-left:auto;font-weight:400}
  .gradient:before{content:"";display:inline-block;width:58px;height:5px;margin-right:10px;vertical-align:middle;border-radius:999px;background:linear-gradient(90deg,#65f17c,#ffde57,#ff5363)}
`));

function widgetGallery(title, panels) {
  return html(`
  <main>
    <header><div><p>AJAZZ AKP03R</p><h1>${title}</h1></div><span>Демонстрационные данные</span></header>
    <div class="themes">${panels.join("")}</div>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:32px 40px;width:1390px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:27px}
  header p,h1,h2{margin:0}header p{font-size:13px;font-weight:650;letter-spacing:.11em;color:#9eb1c8}
  h1{font-size:37px;line-height:1.18;letter-spacing:-.035em;margin-top:5px}header span{font-size:13px;color:#a9b6c9}
  .themes{display:grid;grid-template-columns:repeat(5,1fr);gap:20px}h2{font-size:16px;font-weight:600;margin-bottom:12px}
  .device{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px;border:1px solid #424b5b;border-radius:17px;background:#252d39;box-shadow:0 7px 14px #03070c66}
  svg{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
`);
}
fs.writeFileSync(path.join(target, "game-themes.html"), widgetGallery("Игровые и системные кнопки", gamingVariants));
fs.writeFileSync(path.join(target, "system-telemetry.html"), widgetGallery("Расширенный мониторинг", systemVariants));

fs.writeFileSync(path.join(target, "rotation-weather.html"), html(`
  <main>
    <header><h1>Карусели и погода</h1><span>Демонстрационные данные</span></header>
    <div class="groups">
      <section><h2>Топ процессов</h2><div class="device">${tile("topProcess", "bars")}${tile("topGpu", "bars")}${tile("topProcess", "bars", false, {
        value: { name: "Korabli64", memoryBytes: 3070901617 }, settings: { topProcessMode: "ram" }
      }, "-ram")}</div></section>
      <section><h2>Вентиляторы</h2><div class="device">${tile("fanSpeed", "ice")}${tile("fanSpeed", "ice", false, {
        value: { name: "CPU Fan", reading: 970, unit: "rpm" }, history: [901, 920, 961, 970]
      }, "-cpu")}</div></section>
      <section><h2>Погода</h2><div class="device">${tile("weather", "ice")}</div></section>
    </div>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:24px 28px;width:795px}header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:17px}
  h1{margin:0;font-size:23px;font-weight:650}header span{font-size:12px;color:#a9b6c9}
  h2{margin:0 0 8px;font-size:14px;font-weight:600}.groups{display:flex;gap:12px}
  .device{display:flex;gap:7px;width:fit-content;padding:8px;border:1px solid #424b5b;border-radius:12px;background:#252d39}
  svg{width:100px;height:100px;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
`));

fs.writeFileSync(path.join(target, "camera-microphone.html"), html(`
  <main>
    <header><h1>Камера и микрофон</h1><span>Демонстрационные данные</span></header>
    <div class="device">
      ${tile("camera", "ice", false, { settings: { indicatorSize: "small" } })}
      ${tile("camera", "ice", false, { value: { name: "Logitech C922", enabled: false } }, "-off")}
      ${tile("microphone", "amber", false, { settings: { indicatorSize: "large" } })}
      ${tile("microphone", "amber", false, { value: { muted: true } }, "-off")}
    </div>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:25px 27px;width:580px}header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}
  h1{margin:0;font-size:21px;font-weight:650}header span{font-size:12px;color:#a9b6c9}
  .device{display:grid;grid-template-columns:repeat(4,112px);gap:8px;width:fit-content;padding:9px;border:1px solid #424b5b;border-radius:13px;background:#252d39}
  svg{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
`));

fs.writeFileSync(path.join(target, "focus.html"), html(`
  <main>
    <header><h1>Крупное значение по нажатию</h1><span>Демонстрационные данные</span></header>
    <div class="device">${["cpuLoad", "gpuTemperature", "ip"].map((metric) => tile(metric, "bars", true)).join("")}</div>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:25px 27px;width:610px}header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}
  h1{margin:0;font-size:21px;font-weight:650;letter-spacing:-.025em}header span{font-size:12px;color:#a9b6c9}
  .device{display:grid;grid-template-columns:repeat(3,112px);justify-content:start;gap:8px;width:fit-content;padding:9px;border:1px solid #424b5b;border-radius:13px;background:#252d39;box-shadow:0 7px 14px #03070c66}
  svg{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
`));

fs.writeFileSync(path.join(target, "ip-display.html"), html(`
  <main>
    <header><h1>Внешний IP и флаг</h1><span>Демонстрационные данные</span></header>
    <div class="sequence">
      <div class="device">${tile("ip", "bars")}</div>
      <span class="interval">5 или 15 с</span>
      <div class="device">${tile("ip", "large", false, { showFlag: true, country: "DE", settings: { theme: "bars", ipMode: "public", ipDisplay: "alternate" } })}</div>
    </div>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:25px 27px;width:460px}header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}
  h1{margin:0;font-size:21px;font-weight:650;letter-spacing:-.025em}header span{font-size:12px;color:#a9b6c9}
  .sequence{display:flex;align-items:center;gap:14px}
  .device{padding:8px;border:1px solid #424b5b;border-radius:12px;background:#252d39;box-shadow:0 7px 14px #03070c66}
  .interval{font-size:12px;font-weight:600;color:#a9b6c9}
  svg{width:102px;height:102px;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
`));
