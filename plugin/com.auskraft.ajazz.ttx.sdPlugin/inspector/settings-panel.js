'use strict';

const form = document.getElementById('settings');
const theme = document.getElementById('theme');
const digitSize = document.getElementById('digit-size');
const digitSizeField = document.getElementById('digit-size-field');
const traffic = document.getElementById('traffic');
const trafficSection = document.getElementById('traffic-section');
const gpuSensor = document.getElementById('gpu-sensor');
const gpuSensorField = document.getElementById('gpu-sensor-field');
const ipSettings = document.getElementById('ip-settings');
const ipMode = document.getElementById('ip-mode');
const ipDisplay = document.getElementById('ip-display');
const ipDisplayField = document.getElementById('ip-display-field');
const ipSeconds = document.getElementById('ip-seconds');
const ipProgress = document.getElementById('ip-progress');
const ipNote = document.getElementById('ip-note');
const fpsProcess = document.getElementById('fps-process');
const fpsProcessField = document.getElementById('fps-process-field');
const pingTarget = document.getElementById('ping-target');
const pingTargetField = document.getElementById('ping-target-field');
const volumeLetter = document.getElementById('volume-letter');
const volumeLetterField = document.getElementById('volume-letter-field');
const connection = document.getElementById('connection');
const { metricForAction, supportsTraffic, normalize, digitSizeRange } = globalThis.AjazzSettings;

let socket;
let registrationId;

for (let size = digitSizeRange.min; size <= digitSizeRange.max; size += 1) {
  digitSize.add(new Option(`${size} px`, String(size)));
}
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') volumeLetter.add(new Option(letter + ':', letter));

function updateIpFields({ ipMode, ipDisplay }) {
  const external = ipMode === 'public';
  ipDisplayField.hidden = !external;
  ipNote.hidden = !external;
  ipNote.textContent = ipDisplay === 'alternate'
    ? 'Флаг определяется по внешнему IP через Cloudflare.'
    : 'Для внешнего IP кнопка обращается к api.ipify.org.';
}

function populate(incoming) {
  const settings = normalize(incoming);
  theme.value = settings.theme;
  digitSize.value = settings.digitSize === null ? '' : String(settings.digitSize);
  traffic.checked = settings.traffic;
  gpuSensor.value = settings.gpuSensor;
  ipMode.value = settings.ipMode;
  ipDisplay.value = settings.ipDisplay;
  ipSeconds.value = String(settings.ipSeconds);
  ipProgress.checked = settings.ipProgress;
  fpsProcess.value = settings.fpsProcess;
  pingTarget.value = settings.pingTarget;
  volumeLetter.value = settings.volumeLetter;
  updateIpFields(settings);
}

for (const input of [theme, digitSize, traffic, gpuSensor, ipMode, ipDisplay, ipSeconds, ipProgress, fpsProcess, pingTarget, volumeLetter]) {
  input.addEventListener('change', () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const settings = normalize({
      theme: theme.value,
      traffic: traffic.checked,
      gpuSensor: gpuSensor.value,
      ipMode: ipMode.value,
      ipDisplay: ipDisplay.value,
      ipSeconds: ipSeconds.value,
      ipProgress: ipProgress.checked,
      digitSize: digitSize.value,
      fpsProcess: fpsProcess.value,
      pingTarget: pingTarget.value,
      volumeLetter: volumeLetter.value
    });
    populate(settings);
    socket.send(JSON.stringify({ event: 'setSettings', context: registrationId, payload: settings }));
  });
}

globalThis.connectElgatoStreamDeckSocket = (port, uuid, event, application, actionInfo) => {
  const info = JSON.parse(actionInfo);
  const metric = metricForAction(info.action);
  if (!metric) return;
  socket?.close();
  registrationId = uuid;
  trafficSection.hidden = !supportsTraffic(metric);
  trafficSection.lastElementChild.textContent = metric.startsWith('cpu') ? 'Светофор CPU' : 'Светофор GPU';
  gpuSensorField.hidden = metric !== 'gpuTemperature';
  ipSettings.hidden = metric !== 'ip';
  digitSizeField.hidden = metric === 'bitwarden';
  fpsProcessField.hidden = metric !== 'fps';
  pingTargetField.hidden = metric !== 'network';
  volumeLetterField.hidden = metric !== 'disk';
  populate(info.payload?.settings);

  const activeSocket = new WebSocket('ws://127.0.0.1:' + port);
  socket = activeSocket;
  activeSocket.addEventListener('open', () => {
    activeSocket.send(JSON.stringify({ event, uuid }));
    activeSocket.send(JSON.stringify({ event: 'getSettings', context: uuid }));
    form.disabled = false;
    connection.hidden = true;
  });
  activeSocket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.event === 'didReceiveSettings') populate(message.payload?.settings);
  });
  activeSocket.addEventListener('close', () => {
    if (activeSocket !== socket) return;
    form.disabled = true;
    connection.hidden = false;
  });
};
