'use strict';

const form = document.getElementById('settings');
const theme = document.getElementById('theme');
const traffic = document.getElementById('traffic');
const trafficSection = document.getElementById('traffic-section');
const ipSettings = document.getElementById('ip-settings');
const ipMode = document.getElementById('ip-mode');
const ipSeconds = document.getElementById('ip-seconds');
const ipNote = document.getElementById('ip-note');
const connection = document.getElementById('connection');
const { metricForAction, supportsTraffic, normalize } = globalThis.AjazzSettings;

let socket;
let registrationId;

function populate(incoming) {
  const settings = normalize(incoming);
  theme.value = settings.theme;
  traffic.checked = settings.traffic;
  ipMode.value = settings.ipMode;
  ipSeconds.value = String(settings.ipSeconds);
  ipNote.hidden = settings.ipMode !== 'public';
}

for (const input of [theme, traffic, ipMode, ipSeconds]) {
  input.addEventListener('change', () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const settings = normalize({
      theme: theme.value,
      traffic: traffic.checked,
      ipMode: ipMode.value,
      ipSeconds: ipSeconds.value
    });
    ipNote.hidden = settings.ipMode !== 'public';
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
  ipSettings.hidden = metric !== 'ip';
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
