const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;
const MAX_MSG_LENGTH = 500;
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_WINDOW_MS = 3000;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_CONNECTIONS_PER_IP = 5;

const ipConnections = new Map();
let waitingQueue = [];
let onlineCount = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Server error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

function getWaiting() {
  waitingQueue = waitingQueue.filter(s => s.readyState === WebSocket.OPEN);
  return waitingQueue.length > 0 ? waitingQueue.shift() : null;
}

function tryMatch(ws) {
  const partner = getWaiting();
  if (partner) {
    ws.partner = partner;
    partner.partner = ws;
    ws.send(JSON.stringify({ type: 'matched' }));
    partner.send(JSON.stringify({ type: 'matched' }));
  } else {
    waitingQueue.push(ws);
    ws.send(JSON.stringify({ type: 'waiting' }));
  }
}

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN) {
    const origin = req.headers['origin'];
    if (origin !== ALLOWED_ORIGIN) { ws.close(1008, 'Origin not allowed'); return; }
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const ipCount = ipConnections.get(ip) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) { ws.close(1008, 'Too many connections'); return; }
  ipConnections.set(ip, ipCount + 1);
  ws.clientIp = ip;

  onlineCount++;
  broadcastOnlineCount();

  ws.partner = null;
  ws.isAlive = true;
  ws.msgTimestamps = [];

  tryMatch(ws);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }

    if (parsed.type === 'message') {
      const now = Date.now();
      ws.msgTimestamps = ws.msgTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (ws.msgTimestamps.length >= RATE_LIMIT_COUNT) {
        ws.send(JSON.stringify({ type: 'error', text: 'Slow down a bit.' }));
        return;
      }
      ws.msgTimestamps.push(now);
      const text = String(parsed.text || '').trim();
      if (!text || text.length > MAX_MSG_LENGTH) return;
      if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
        ws.partner.send(JSON.stringify({ type: 'message', text }));
      }
    }

    if (parsed.type === 'typing') {
      if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
        ws.partner.send(JSON.stringify({ type: 'typing' }));
      }
    }

    if (parsed.type === 'stop_typing') {
      if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
        ws.partner.send(JSON.stringify({ type: 'stop_typing' }));
      }
    }

    if (parsed.type === 'skip') {
      handleDisconnect(ws, 'skipped');
      ws.partner = null;
      ws.msgTimestamps = [];
      tryMatch(ws);
    }
  });

  ws.on('close', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();
    handleDisconnect(ws, 'disconnected');
    waitingQueue = waitingQueue.filter(s => s !== ws);
    if (ws.clientIp) {
      const c = ipConnections.get(ws.clientIp) || 1;
      if (c <= 1) ipConnections.delete(ws.clientIp);
      else ipConnections.set(ws.clientIp, c - 1);
    }
  });

  ws.on('error', () => { ws.terminate(); });
});

function handleDisconnect(ws, reason) {
  if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
    ws.partner.send(JSON.stringify({ type: 'stranger_left', reason }));
    ws.partner.partner = null;
    tryMatch(ws.partner);
  }
  ws.partner = null;
}

function broadcastOnlineCount() {
  const msg = JSON.stringify({ type: 'online_count', count: onlineCount });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on('close', () => clearInterval(heartbeat));
server.listen(PORT, () => console.log(`sm1 running on port ${PORT}`));