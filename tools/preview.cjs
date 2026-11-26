"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { renderSvg } = require("../plugin/com.auskraft.ajazz.ttx.sdPlugin/render.js");

const metrics = ["cpuTemperature", "gpuTemperature", "ramUsedGb", "cpuLoad", "gpuLoad", "ip"];
const themes = {
  bars: "Пиксельные столбики",
  lines: "Тонкие линии",
  large: "Цифры крупнее"
};
const example = {
  cpuTemperature: [77, [57, 59, 61, 69, 74, 81, 88, 83, 74, 69, 70, 74, 77]],
  gpuTemperature: [67, [48, 50, 53, 57, 62, 70, 81, 79, 74, 68, 65, 65, 67]],
  ramUsedGb: [14.8, [7, 7.5, 7.4, 8, 8, 9, 11, 10.5, 11, 12.8, 14.4, 14.6, 14.8]],
  cpuLoad: [39, [22, 24, 36, 58, 98, 85, 66, 39, 34, 61, 36, 30, 39]],
  gpuLoad: [83, [18, 26, 28, 43, 59, 71, 96, 97, 84, 71, 65, 82, 83]],
  ip: ["203.0.113.42", []]
};

function tile(metric, theme, focus = false) {
  const [exampleValue, history] = example[metric];
  const value = focus && metric === "cpuLoad" ? 18 : exampleValue;
  const key = focus ? "focus-" + metric : theme + "-" + metric;
  return renderSvg({
    metric, value, history, focus, settings: { theme, traffic: true, ipSeconds: 15 },
    snapshot: { ramTotalGb: 32 }
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
const sheet = [logo, logo, ...metrics.map((metric) => tile(metric, "bars"))];
fs.writeFileSync(path.join(target, "icons.html"), html("<main>" + sheet.join("") + "</main>",
  "html,body{margin:0}main{display:grid;grid-template-columns:repeat(4,128px);width:512px}svg{display:block;width:128px;height:128px}"));

const variants = Object.entries(themes).map(([theme, name]) =>
  `<section><h2>${name}</h2><div class="device">${metrics.map((metric) => tile(metric, theme)).join("")}</div></section>`);
fs.writeFileSync(path.join(target, "themes.html"), html(`
  <main>
    <header><div><p>AJAZZ AKP03R</p><h1>Мониторинг ПК</h1></div><span>Демонстрационные данные</span></header>
    <div class="themes">${variants.join("")}</div>
    <footer><span class="cpu">CPU</span><span class="gpu">GPU</span><span class="ram">RAM</span><span class="ip">IP</span><span class="gradient">Цвет графика меняется по значению</span></footer>
  </main>`, `
  *{box-sizing:border-box}html,body{margin:0;background:#10151d;color:#f0f4fb;font-family:"Segoe UI",sans-serif}
  main{padding:37px 40px;width:1110px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:35px}
  header p,h1,h2{margin:0}header p{font-size:13px;font-weight:650;letter-spacing:.11em;color:#9eb1c8}
  h1{font-size:37px;line-height:1.18;letter-spacing:-.035em;margin-top:5px}header span{font-size:13px;color:#a9b6c9}
  .themes{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}h2{font-size:16px;font-weight:600;margin-bottom:12px}
  .device{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px;border:1px solid #424b5b;border-radius:17px;background:#252d39;box-shadow:0 7px 14px #03070c66}
  svg{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 1px 3px #000}
  footer{display:flex;gap:16px;margin-top:27px;align-items:center;font-size:13px;font-weight:650;color:#a9b6c9}
  .cpu{color:#ff777f}.gpu{color:#8aef66}.ram{color:#79baff}.ip{color:#7bcafa}.gradient{margin-left:auto;font-weight:400}
  .gradient:before{content:"";display:inline-block;width:58px;height:5px;margin-right:10px;vertical-align:middle;border-radius:999px;background:linear-gradient(90deg,#65f17c,#ffde57,#ff5363)}
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
