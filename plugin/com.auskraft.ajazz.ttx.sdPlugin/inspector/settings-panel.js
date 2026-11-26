'use strict';

const form = document.getElementById('settings');
const theme = document.getElementById('theme');
const themeField = document.getElementById('theme-field');
const digitSize = document.getElementById('digit-size');
const digitSizeField = document.getElementById('digit-size-field');
const digitSizeLabel = document.getElementById('digit-size-label');
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
const fpsSettings = document.getElementById('fps-settings');
const fpsMode = document.getElementById('fps-mode');
const fpsProcess = document.getElementById('fps-process');
const fpsProcessField = document.getElementById('fps-process-field');
const fpsProcessHint = document.getElementById('fps-process-hint');
const fpsApps = document.getElementById('fps-apps');
const fpsAppsStatus = document.getElementById('fps-apps-status');
const refreshFpsApps = document.getElementById('refresh-fps-apps');
const pingTarget = document.getElementById('ping-target');
const pingTargetField = document.getElementById('ping-target-field');
const volumeLetter = document.getElementById('volume-letter');
const volumeLetterField = document.getElementById('volume-letter-field');
const audioSettings = document.getElementById('audio-settings');
const audioOutputA = document.getElementById('audio-output-a');
const audioOutputB = document.getElementById('audio-output-b');
const audioShowVolume = document.getElementById('audio-show-volume');
const audioStatus = document.getElementById('audio-status');
const refreshAudioOutputs = document.getElementById('refresh-audio-outputs');
const cameraSettings = document.getElementById('camera-settings');
const cameraDevice = document.getElementById('camera-device');
const cameraStatus = document.getElementById('camera-status');
const refreshCameras = document.getElementById('refresh-cameras');
const bitwardenPathField = document.getElementById('bitwarden-path-field');
const bitwardenPath = document.getElementById('bitwarden-path');
const bitwardenPathHint = document.getElementById('bitwarden-path-hint');
const connection = document.getElementById('connection');
const {
  metricForAction, supportsTraffic, normalize, normalizeAudioOutputId, normalizeCameraId, normalizeFpsExecutable,
  normalizeBitwardenPath, digitSizeRange
} = globalThis.AjazzSettings;
const devicePickers = {
  audioOutput: {
    request: 'audioOutputs', button: refreshAudioOutputs, normalizeId: normalizeAudioOutputId, update: updateAudioFields
  },
  camera: { request: 'cameras', button: refreshCameras, normalizeId: normalizeCameraId, update: updateCameraFields },
  fps: { request: 'fpsApps', button: refreshFpsApps, normalizeId: normalizeFpsExecutable, update: updateFpsApps }
};

let socket;
let registrationId;
let settings = normalize();
let fpsDraft = false;
let bitwardenDraft = false;
let devicePicker = null;
let deviceReading = null;
let deviceRequestId = null;
let deviceTimeout = null;
let deviceSequence = 0;

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

function updateFpsFields() {
  fpsProcessField.hidden = fpsSettings.hidden || fpsMode.value !== 'manual';
  fpsProcessHint.textContent = fpsDraft && fpsProcess.value.trim()
    ? 'Проверь имя или полный путь к файлу .exe игры.'
    : 'Укажи имя или путь к файлу .exe игры. Подсказки показывают открытые приложения.';
}

function updateFpsApps() {
  const apps = deviceReading?.devices ?? [];
  fpsApps.replaceChildren(...apps.map(({ id }) => new Option(id, id)));
  refreshFpsApps.disabled = Boolean(deviceRequestId);
  const status = deviceRequestId ? 'Ищу открытые приложения…' :
    deviceReading && !deviceReading.available ? 'Не удалось получить список. Можно указать .exe вручную.' :
    deviceReading && apps.length === 0 ? 'Открытые приложения не найдены.' : '';
  fpsAppsStatus.textContent = status;
  fpsAppsStatus.hidden = !status;
}

function updateBitwardenField() {
  bitwardenPathHint.textContent = bitwardenDraft
    ? 'Укажи полный путь к Bitwarden.exe на локальном диске.'
    : 'Оставь поле пустым для автоматического поиска Bitwarden.';
}

function populateAudioChoice(select, selected, other) {
  select.replaceChildren(new Option('Выбрать устройство', ''));
  const devices = deviceReading?.devices ?? [];
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
  refreshAudioOutputs.disabled = Boolean(deviceRequestId);
  if (deviceRequestId) {
    audioStatus.textContent = 'Обновляю список устройств Windows…';
  } else if (!deviceReading?.available) {
    audioStatus.textContent = 'Не удалось получить список аудиовыходов Windows.';
  } else if (deviceReading.devices.length < 2) {
    audioStatus.textContent = 'Подключи хотя бы два аудиовыхода.';
  } else if (!first || !second || first === second) {
    audioStatus.textContent = 'Выбери два разных выхода для переключения.';
  } else if (![first, second].every((selected) => deviceReading.devices.some(({ id }) => id === selected))) {
    audioStatus.textContent = 'Один из выбранных выходов сейчас недоступен.';
  } else {
    audioStatus.textContent = 'Нажми кнопку на панели, чтобы сменить выход звука.';
  }
}

function updateCameraFields() {
  const { cameraId } = settings;
  const devices = deviceReading?.devices ?? [];
  const selected = devices.find(({ id }) => id === cameraId);
  cameraDevice.replaceChildren(new Option('Авто (одна камера)', ''));
  for (const { id, name } of devices) cameraDevice.add(new Option(name, id));
  if (cameraId && !selected) cameraDevice.add(new Option('Сохранённая камера недоступна', cameraId));
  cameraDevice.value = cameraId;
  cameraDevice.disabled = !cameraId && devices.length === 0;
  refreshCameras.disabled = Boolean(deviceRequestId);
  if (deviceRequestId) {
    cameraStatus.textContent = 'Обновляю список камер Windows…';
  } else if (!deviceReading?.available) {
    cameraStatus.textContent = 'Не удалось получить список камер Windows.';
  } else if (cameraId && !selected) {
    cameraStatus.textContent = 'Подключи выбранную камеру или выбери другую.';
  } else if (devices.length === 0) {
    cameraStatus.textContent = 'Подключи камеру и обнови список.';
  } else if (!cameraId && devices.length > 1) {
    cameraStatus.textContent = 'Выбери камеру для этой кнопки.';
  } else {
    cameraStatus.textContent = 'Нажми кнопку на панели, чтобы включить или выключить камеру. Windows может запросить права администратора.';
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
  if (!fpsDraft) {
    fpsMode.value = settings.fpsProcess === 'auto' ? 'auto' : 'manual';
    fpsProcess.value = settings.fpsManualProcess;
  }
  pingTarget.value = settings.pingTarget;
  volumeLetter.value = settings.volumeLetter;
  audioShowVolume.checked = settings.audioShowVolume;
  if (!bitwardenDraft) bitwardenPath.value = settings.bitwardenPath;
  updateIpFields(settings);
  updateFpsFields();
  updateBitwardenField();
  devicePicker?.update();
}

for (const input of [
  theme, digitSize, traffic, gpuSensor, ipMode, ipDisplay, ipSeconds, ipProgress, fpsMode, fpsProcess, pingTarget, volumeLetter,
  audioOutputA, audioOutputB, audioShowVolume, cameraDevice, bitwardenPath
]) {
  input.addEventListener('change', () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    let fpsChoice = {};
    if (input === fpsMode || input === fpsProcess) {
      const executable = normalizeFpsExecutable(fpsProcess.value);
      const manual = fpsMode.value === 'manual';
      fpsDraft = manual && !executable;
      if (input === fpsMode && manual && !deviceReading) refreshFpsApps.onclick?.();
      if (fpsDraft) {
        updateFpsFields();
        return;
      }
      fpsChoice = { fpsProcess: manual ? executable : 'auto', fpsManualProcess: executable || settings.fpsManualProcess };
    }
    let savedBitwardenPath = settings.bitwardenPath;
    if (input === bitwardenPath) {
      savedBitwardenPath = normalizeBitwardenPath(bitwardenPath.value);
      bitwardenDraft = Boolean(bitwardenPath.value.trim() && !savedBitwardenPath);
      if (bitwardenDraft) {
        updateBitwardenField();
        return;
      }
    }
    populate({
      ...settings,
      ...fpsChoice,
      theme: theme.value,
      traffic: traffic.checked,
      gpuSensor: gpuSensor.value,
      ipMode: ipMode.value,
      ipDisplay: ipDisplay.value,
      ipSeconds: ipSeconds.value,
      ipProgress: ipProgress.checked,
      digitSize: digitSize.value,
      pingTarget: pingTarget.value,
      volumeLetter: volumeLetter.value,
      audioShowVolume: audioShowVolume.checked,
      audioOutputA: audioSettings.hidden ? settings.audioOutputA : audioOutputA.value,
      audioOutputB: audioSettings.hidden ? settings.audioOutputB : audioOutputB.value,
      cameraId: cameraSettings.hidden ? settings.cameraId : cameraDevice.value,
      bitwardenPath: savedBitwardenPath
    });
    socket.send(JSON.stringify({ event: 'setSettings', context: registrationId, payload: settings }));
  });
}

function receiveDevices(payload) {
  if (!deviceRequestId || payload?.requestId !== deviceRequestId || !devicePicker) return;
  clearTimeout(deviceTimeout);
  deviceRequestId = null;
  const devices = payload.available && Array.isArray(payload.devices) ? payload.devices : [];
  deviceReading = {
    available: payload.available === true,
    devices: devices
      .map((device) => ({ id: devicePicker.normalizeId(device?.id), name: device?.name }))
      .filter(({ id, name }) => id && typeof name === 'string' && name)
  };
  devicePicker.update();
}

globalThis.connectElgatoStreamDeckSocket = (port, uuid, event, application, actionInfo) => {
  const info = JSON.parse(actionInfo);
  const metric = metricForAction(info.action);
  if (!metric) return;
  socket?.close();
  form.disabled = true;
  clearTimeout(deviceTimeout);
  deviceRequestId = null;
  deviceReading = null;
  fpsDraft = false;
  bitwardenDraft = false;
  devicePicker = devicePickers[metric];
  registrationId = uuid;
  trafficSection.hidden = !supportsTraffic(metric);
  trafficSection.lastElementChild.textContent = metric.startsWith('cpu') ? 'Светофор CPU' : 'Светофор GPU';
  gpuSensorField.hidden = metric !== 'gpuTemperature';
  ipSettings.hidden = metric !== 'ip';
  themeField.hidden = metric === 'bitwarden';
  digitSizeField.hidden = metric === 'bitwarden' || metric === 'audioOutput';
  digitSizeLabel.textContent = metric === 'camera' ? 'Размер текста' : 'Размер цифр';
  fpsSettings.hidden = metric !== 'fps';
  pingTargetField.hidden = metric !== 'network';
  volumeLetterField.hidden = metric !== 'disk';
  audioSettings.hidden = metric !== 'audioOutput';
  cameraSettings.hidden = metric !== 'camera';
  bitwardenPathField.hidden = metric !== 'bitwarden';
  populate(info.payload?.settings);

  const activeSocket = new WebSocket('ws://127.0.0.1:' + port);
  socket = activeSocket;
  function requestDevices() {
    if (!devicePicker || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN || deviceRequestId) return;
    const requestId = `${Date.now()}-${++deviceSequence}`;
    deviceRequestId = requestId;
    devicePicker.update();
    activeSocket.send(JSON.stringify({
      event: 'sendToPlugin', action: info.action, context: uuid,
      payload: { request: devicePicker.request, requestId, actionContext: info.context }
    }));
    deviceTimeout = setTimeout(() => receiveDevices({ requestId, available: false }), 10000);
  }
  if (devicePicker) devicePicker.button.onclick = requestDevices;
  activeSocket.addEventListener('open', () => {
    if (activeSocket !== socket) return;
    activeSocket.send(JSON.stringify({ event, uuid }));
    activeSocket.send(JSON.stringify({ event: 'getSettings', context: uuid }));
    form.disabled = false;
    connection.hidden = true;
    if (devicePicker && (metric !== 'fps' || fpsMode.value === 'manual')) requestDevices();
  });
  activeSocket.addEventListener('message', ({ data }) => {
    if (activeSocket !== socket) return;
    const message = JSON.parse(data);
    if (message.event === 'didReceiveSettings') {
      populate(message.payload?.settings);
      if (metric === 'fps' && fpsMode.value === 'manual' && !deviceReading) requestDevices();
    } else if (message.event === 'sendToPropertyInspector') {
      receiveDevices(message.payload);
    }
  });
  activeSocket.addEventListener('close', () => {
    if (activeSocket !== socket) return;
    clearTimeout(deviceTimeout);
    deviceRequestId = null;
    form.disabled = true;
    connection.hidden = false;
  });
};
