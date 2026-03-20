const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // set to 'https://sm1.online' in Railway
const MAX_MSG_LENGTH = 500;
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_WINDOW_MS = 3000;
const MAX_PAYLOAD_BYTES = 4096; // 4KB max WebSocket frame
const MAX_CONNECTIONS_PER_IP = 5; // stop tab farming

const ipConnections = new Map(); // ip -> count

// --- HTTP server (serves index.html) ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Server error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

let waitingUser = null; // holds one waiting socket
let onlineCount = 0;

wss.on('connection', (ws, req) => {
  // Origin check (only enforced if ALLOWED_ORIGIN is set)
  if (ALLOWED_ORIGIN) {
    const origin = req.headers['origin'];
    if (origin !== ALLOWED_ORIGIN) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
  }

  // Per-IP connection limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const ipCount = ipConnections.get(ip) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections');
    return;
  }
  ipConnections.set(ip, ipCount + 1);
  ws.clientIp = ip;

  onlineCount++;
  broadcastOnlineCount();

  // Per-connection state
  ws.partner = null;
  ws.isAlive = true;
  ws.msgTimestamps = []; // for rate limiting

  // Try to match with waiting user
  if (waitingUser && waitingUser.readyState === WebSocket.OPEN) {
    const partner = waitingUser;
    waitingUser = null;

    ws.partner = partner;
    partner.partner = ws;

    ws.send(JSON.stringify({ type: 'matched' }));
    partner.send(JSON.stringify({ type: 'matched' }));
  } else {
    waitingUser = ws;
    ws.send(JSON.stringify({ type: 'waiting' }));
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    // Parse message
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed.type === 'message') {
      // Rate limiting
      const now = Date.now();
      ws.msgTimestamps = ws.msgTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (ws.msgTimestamps.length >= RATE_LIMIT_COUNT) {
        ws.send(JSON.stringify({ type: 'error', text: 'Slow down a bit.' }));
        return;
      }
      ws.msgTimestamps.push(now);

      // Length check
      const text = String(parsed.text || '').trim();
      if (!text || text.length > MAX_MSG_LENGTH) return;

      // Forward to partner
      if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
        ws.partner.send(JSON.stringify({ type: 'message', text }));
      }
    }

    if (parsed.type === 'skip') {
      handleDisconnect(ws, 'skipped');
      // Re-queue this user
      ws.partner = null;
      ws.msgTimestamps = [];
      if (waitingUser && waitingUser.readyState === WebSocket.OPEN) {
        const partner = waitingUser;
        waitingUser = null;
        ws.partner = partner;
        partner.partner = ws;
        ws.send(JSON.stringify({ type: 'matched' }));
        partner.send(JSON.stringify({ type: 'matched' }));
      } else {
        waitingUser = ws;
        ws.send(JSON.stringify({ type: 'waiting' }));
      }
    }
  });

  ws.on('close', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();
    handleDisconnect(ws, 'disconnected');
    if (waitingUser === ws) waitingUser = null;
    // Decrement IP count
    if (ws.clientIp) {
      const c = ipConnections.get(ws.clientIp) || 1;
      if (c <= 1) ipConnections.delete(ws.clientIp);
      else ipConnections.set(ws.clientIp, c - 1);
    }
  });

  ws.on('error', () => {
    ws.terminate();
  });
});

function handleDisconnect(ws, reason) {
  if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
    ws.partner.send(JSON.stringify({ type: 'stranger_left', reason }));
    // Put partner back in queue
    ws.partner.partner = null;
    if (waitingUser && waitingUser.readyState === WebSocket.OPEN && waitingUser !== ws.partner) {
      const newPartner = waitingUser;
      waitingUser = null;
      ws.partner.partner = newPartner;
      newPartner.partner = ws.partner;
      ws.partner.send(JSON.stringify({ type: 'matched' }));
      newPartner.send(JSON.stringify({ type: 'matched' }));
    } else {
      waitingUser = ws.partner;
      ws.partner.send(JSON.stringify({ type: 'waiting' }));
    }
  }
  ws.partner = null;
}

function broadcastOnlineCount() {
  const msg = JSON.stringify({ type: 'online_count', count: onlineCount });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Heartbeat — drop dead connections every 30s
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`sm1 server running on port ${PORT}`);
});
