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
const audioSettings = document.getElementById('audio-settings');
const audioOutputA = document.getElementById('audio-output-a');
const audioOutputB = document.getElementById('audio-output-b');
const audioStatus = document.getElementById('audio-status');
const refreshAudioOutputs = document.getElementById('refresh-audio-outputs');
const connection = document.getElementById('connection');
const { metricForAction, supportsTraffic, normalize, normalizeAudioOutputId, digitSizeRange } = globalThis.AjazzSettings;

let socket;
let registrationId;
let settings = normalize();
let audioReading = null;
let audioRequestId = null;
let audioTimeout = null;
let audioSequence = 0;

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

function populateAudioChoice(select, selected, other) {
  select.replaceChildren(new Option('Выбрать устройство', ''));
  const devices = audioReading?.devices ?? [];
  for (const { id, name } of devices) {
    const option = new Option(name, id);
    option.disabled = id === other && id !== selected;
    select.add(option);
  }
  if (selected && !devices.some(({ id }) => id === selected)) {
    select.add(new Option('Сохранённое устройство недоступно', selected));
  }
  select.value = selected;
  select.disabled = devices.length === 0;
}

function updateAudioFields() {
  const { audioOutputA: first, audioOutputB: second } = settings;
  populateAudioChoice(audioOutputA, first, second);
  populateAudioChoice(audioOutputB, second, first);
  refreshAudioOutputs.disabled = Boolean(audioRequestId);
  if (audioRequestId) {
    audioStatus.textContent = 'Обновляю список устройств Windows…';
  } else if (!audioReading?.available) {
    audioStatus.textContent = 'Не удалось получить список аудиовыходов Windows.';
  } else if (audioReading.devices.length < 2) {
    audioStatus.textContent = 'Подключи хотя бы два аудиовыхода.';
  } else if (!first || !second || first === second) {
    audioStatus.textContent = 'Выбери два разных выхода для переключения.';
  } else if (![first, second].every((selected) => audioReading.devices.some(({ id }) => id === selected))) {
    audioStatus.textContent = 'Один из выбранных выходов сейчас недоступен.';
  } else {
    audioStatus.textContent = 'Нажми кнопку на панели, чтобы сменить выход звука.';
  }
}

function populate(incoming) {
  settings = normalize(incoming);
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
  if (!audioSettings.hidden) updateAudioFields();
}

for (const input of [
  theme, digitSize, traffic, gpuSensor, ipMode, ipDisplay, ipSeconds, ipProgress, fpsProcess, pingTarget, volumeLetter,
  audioOutputA, audioOutputB
]) {
  input.addEventListener('change', () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    populate({
      ...settings,
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
      volumeLetter: volumeLetter.value,
      audioOutputA: audioSettings.hidden ? settings.audioOutputA : audioOutputA.value,
      audioOutputB: audioSettings.hidden ? settings.audioOutputB : audioOutputB.value
    });
    socket.send(JSON.stringify({ event: 'setSettings', context: registrationId, payload: settings }));
  });
}

function receiveAudioOutputs(payload) {
  if (!audioRequestId || payload?.requestId !== audioRequestId) return;
  clearTimeout(audioTimeout);
  audioRequestId = null;
  const devices = payload.available && Array.isArray(payload.devices) ? payload.devices : [];
  audioReading = {
    available: payload.available === true,
    devices: devices
      .map((device) => ({ id: normalizeAudioOutputId(device?.id), name: device?.name }))
      .filter(({ id, name }) => id && typeof name === 'string' && name)
  };
  updateAudioFields();
}

globalThis.connectElgatoStreamDeckSocket = (port, uuid, event, application, actionInfo) => {
  const info = JSON.parse(actionInfo);
  const metric = metricForAction(info.action);
  if (!metric) return;
  socket?.close();
  clearTimeout(audioTimeout);
  audioRequestId = null;
  audioReading = null;
  registrationId = uuid;
  trafficSection.hidden = !supportsTraffic(metric);
  trafficSection.lastElementChild.textContent = metric.startsWith('cpu') ? 'Светофор CPU' : 'Светофор GPU';
  gpuSensorField.hidden = metric !== 'gpuTemperature';
  ipSettings.hidden = metric !== 'ip';
  digitSizeField.hidden = metric === 'bitwarden' || metric === 'audioOutput';
  fpsProcessField.hidden = metric !== 'fps';
  pingTargetField.hidden = metric !== 'network';
  volumeLetterField.hidden = metric !== 'disk';
  audioSettings.hidden = metric !== 'audioOutput';
  populate(info.payload?.settings);

  const activeSocket = new WebSocket('ws://127.0.0.1:' + port);
  socket = activeSocket;
  function requestAudioOutputs() {
    if (activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN || audioRequestId) return;
    const requestId = `${Date.now()}-${++audioSequence}`;
    audioRequestId = requestId;
    updateAudioFields();
    activeSocket.send(JSON.stringify({
      event: 'sendToPlugin', action: info.action, context: uuid,
      payload: { request: 'audioOutputs', requestId, actionContext: info.context }
    }));
    audioTimeout = setTimeout(() => receiveAudioOutputs({ requestId, available: false }), 10000);
  }
  refreshAudioOutputs.onclick = metric === 'audioOutput' ? requestAudioOutputs : null;
  activeSocket.addEventListener('open', () => {
    if (activeSocket !== socket) return;
    activeSocket.send(JSON.stringify({ event, uuid }));
    activeSocket.send(JSON.stringify({ event: 'getSettings', context: uuid }));
    form.disabled = false;
    connection.hidden = true;
    if (metric === 'audioOutput') requestAudioOutputs();
  });
  activeSocket.addEventListener('message', ({ data }) => {
    if (activeSocket !== socket) return;
    const message = JSON.parse(data);
    if (message.event === 'didReceiveSettings') populate(message.payload?.settings);
    if (metric === 'audioOutput' && message.event === 'sendToPropertyInspector') {
      receiveAudioOutputs(message.payload);
    }
  });
  activeSocket.addEventListener('close', () => {
    if (activeSocket !== socket) return;
    clearTimeout(audioTimeout);
    audioRequestId = null;
    form.disabled = true;
    connection.hidden = false;
  });
};
