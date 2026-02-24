import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dns from 'dns/promises';
import net from 'net';
import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'session');
const RECONNECT_DELAY_MS = 60_000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let reconnectTimer = null;
let reconnectAt = null;
let connectionState = {
  state: 'starting',
  qr: null,
  statusCode: null,
  lastDisconnect: null,
  reconnectAt: null
};

const broadcast = (message) => {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
};

const updateAndBroadcast = (partial) => {
  connectionState = { ...connectionState, ...partial };
  broadcast({ type: 'connection', data: connectionState });
};

const clearReconnect = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAt = null;
  }
};

const scheduleReconnect = () => {
  if (reconnectTimer) {
    return;
  }
  reconnectAt = Date.now() + RECONNECT_DELAY_MS;
  updateAndBroadcast({ reconnectAt });
  logger.warn({ reconnectAt, delayMs: RECONNECT_DELAY_MS }, 'Programando reconexión con backoff');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAt = null;
    startWhatsApp('backoff-retry');
  }, RECONNECT_DELAY_MS);
};

const statusCodeFromError = (err) => {
  return err?.output?.statusCode ?? err?.statusCode ?? null;
};

async function startWhatsApp(origin = 'initial') {
  clearReconnect();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  updateAndBroadcast({ state: 'connecting', qr: null, statusCode: null, reconnectAt: null });
  logger.info({ origin, sessionDir: SESSION_DIR }, 'Iniciando conexión a WhatsApp');

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    const statusCode = statusCodeFromError(lastDisconnect?.error);

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      updateAndBroadcast({ state: 'qr', qr: qrDataUrl, statusCode: null, lastDisconnect: null });
      logger.info({ event: 'qr' }, 'connection.update: QR generado');
    }

    if (connection === 'open') {
      updateAndBroadcast({ state: 'open', qr: null, statusCode: null, lastDisconnect: null, reconnectAt: null });
      logger.info({ event: 'open' }, 'connection.update: conexión abierta');
    }

    if (connection === 'close') {
      const reason = statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      updateAndBroadcast({
        state: 'close',
        statusCode,
        lastDisconnect: String(lastDisconnect?.error || 'unknown'),
        qr: null
      });

      logger.warn({ event: 'close', statusCode, shouldReconnect }, 'connection.update: conexión cerrada');

      if (shouldReconnect) {
        scheduleReconnect();
      }
    }
  });
}

async function tcpTest(host, port = 443, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    let done = false;

    const finish = (result) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout', ms: Date.now() - start }));
    socket.on('connect', () => finish({ ok: true, ms: Date.now() - start }));
    socket.on('error', (err) => finish({ ok: false, error: err.message, ms: Date.now() - start }));
  });
}

async function httpsTest(url = 'https://web.whatsapp.com', timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: true, statusCode: res.statusCode, ms: Date.now() - start });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', ms: Date.now() - start });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message, ms: Date.now() - start });
    });
  });
}

app.get('/api/state', (_req, res) => {
  res.json({ ...connectionState, sessionDir: SESSION_DIR });
});

app.get('/api/nettest', async (_req, res) => {
  const host = 'web.whatsapp.com';
  const dnsStart = Date.now();
  let dnsResult;

  try {
    const addresses = await dns.lookup(host, { all: true });
    dnsResult = { ok: true, addresses, ms: Date.now() - dnsStart };
  } catch (error) {
    dnsResult = { ok: false, error: error.message, ms: Date.now() - dnsStart };
  }

  const [httpsResult, tcpResult] = await Promise.all([
    httpsTest('https://web.whatsapp.com'),
    tcpTest(host, 443)
  ]);

  res.json({
    target: host,
    timestamp: new Date().toISOString(),
    dns: dnsResult,
    https: httpsResult,
    tcp443: tcpResult
  });
});

app.post('/api/regenerate-session', async (_req, res) => {
  try {
    clearReconnect();
    if (sock) {
      try {
        await sock.logout();
      } catch (error) {
        logger.warn({ error: error.message }, 'logout falló, continuando con borrado de sesión');
      }
      sock.end(new Error('Session regeneration requested'));
    }

    await fs.rm(SESSION_DIR, { recursive: true, force: true });
    updateAndBroadcast({ state: 'session-reset', qr: null, statusCode: null, lastDisconnect: null });
    await startWhatsApp('session-regeneration');

    res.json({ ok: true, message: 'Sesión regenerada, esperando nuevo QR' });
  } catch (error) {
    logger.error({ error: error.message }, 'Error regenerando sesión');
    res.status(500).json({ ok: false, error: error.message });
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connection', data: connectionState }));
});

server.listen(PORT, async () => {
  logger.info({ port: PORT }, 'Servidor iniciado');
  await startWhatsApp();
});
