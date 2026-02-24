# Diagnóstico mínimo Baileys / WhatsApp Web

Proyecto mínimo para depurar conexión de Baileys con:
- Panel web con estado + QR.
- `GET /api/nettest` (DNS/HTTPS/TCP contra `web.whatsapp.com`).
- Reconexión con backoff fijo de 60s.
- `SESSION_DIR` configurable y botón para regenerar sesión.

## Requisitos
- Node 20+

## Uso
1. Copia variables:
   ```bash
   cp .env.example .env
   ```
2. Instala dependencias:
   ```bash
   npm install
   ```
3. Inicia:
   ```bash
   npm start
   ```
4. Abre `http://localhost:3000`.

## Endpoints
- `GET /api/state`
- `GET /api/nettest`
- `POST /api/regenerate-session`
