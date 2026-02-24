const stateEl = document.getElementById('state');
const statusCodeEl = document.getElementById('statusCode');
const reconnectEl = document.getElementById('reconnect');
const qrEl = document.getElementById('qr');
const nettestEl = document.getElementById('nettest');

const setState = (data) => {
  stateEl.textContent = data.state ?? '-';
  statusCodeEl.textContent = data.statusCode ?? '-';

  if (data.reconnectAt) {
    reconnectEl.textContent = new Date(data.reconnectAt).toLocaleTimeString();
  } else {
    reconnectEl.textContent = '-';
  }

  if (data.qr) {
    qrEl.src = data.qr;
    qrEl.style.display = 'block';
  } else {
    qrEl.removeAttribute('src');
    qrEl.style.display = 'none';
  }
};

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'connection') {
    setState(msg.data);
  }
};

ws.onerror = () => {
  stateEl.textContent = 'ws-error';
};

document.getElementById('btnNettest').addEventListener('click', async () => {
  nettestEl.textContent = 'Probando...';
  const res = await fetch('/api/nettest');
  const data = await res.json();
  nettestEl.textContent = JSON.stringify(data, null, 2);
});

document.getElementById('btnRegenerate').addEventListener('click', async () => {
  const ok = confirm('Esto borrará la sesión y forzará nuevo QR. ¿Continuar?');
  if (!ok) return;

  const res = await fetch('/api/regenerate-session', { method: 'POST' });
  const data = await res.json();
  nettestEl.textContent = JSON.stringify(data, null, 2);
});
