/**
 * UnsentWords — TikTok Chat Bridge
 * Reads live chat, detects heart messages + gifts, broadcasts to overlay via WebSocket
 */

const { WebcastPushConnection } = require('tiktok-live-connector');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || '';
const TRIGGER_EMOJI = '\u2665'; // ♥

// --- HTTP server (serves status page + admin panel) ---
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: !!tiktokClient, username: TIKTOK_USERNAME }));
    return;
  }
  if (req.url === '/admin' || req.url === '/') {
    const html = buildAdminPage();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end();
});

// --- WebSocket server (talks to overlay) ---
const wss = new WebSocketServer({ server: httpServer });
const overlayClients = new Set();

wss.on('connection', (ws) => {
  overlayClients.add(ws);
  console.log('[WS] Overlay connected. Total:', overlayClients.size);
  ws.send(JSON.stringify({ type: 'connected', username: TIKTOK_USERNAME }));
  ws.on('close', () => { overlayClients.delete(ws); console.log('[WS] Overlay disconnected.'); });
  ws.on('error', () => overlayClients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  overlayClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// --- TikTok connection ---
let tiktokClient = null;
let reconnectTimer = null;

const GIFT_TIERS = {
  // Rose = 1 diamond
  rose: ['Rose', 'rosa'],
  // Star tier = 5-49 diamonds  
  star: ['Star', 'Estrella', 'Sunglasses', 'GG', 'Heart Me', 'Mishroom'],
  // Galaxy tier = 50+ diamonds
  galaxy: ['Galaxy', 'Drama Queen', 'Crown', 'Lion', 'Rocket', 'Universe'],
};

function getGiftTier(giftName, diamondCount) {
  if (diamondCount >= 50) return 'galaxy';
  if (diamondCount >= 5) return 'star';
  return 'rose';
}

function connectToTikTok(username) {
  if (!username) { console.log('[TikTok] No username set. Set TIKTOK_USERNAME env var.'); return; }
  if (tiktokClient) { try { tiktokClient.disconnect(); } catch(e){} }

  console.log('[TikTok] Connecting to @' + username + '...');
  tiktokClient = new WebcastPushConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: true,
    reconnectEnabled: true,
    reconnectDelay: 5000,
  });

  tiktokClient.connect().then(state => {
    console.log('[TikTok] Connected! Room:', state.roomId);
    broadcast({ type: 'tiktok_connected', username });
  }).catch(err => {
    console.error('[TikTok] Connect error:', err.message);
    broadcast({ type: 'tiktok_error', message: err.message });
    scheduleReconnect(username);
  });

  // ♥ chat messages
  tiktokClient.on('chat', data => {
    const text = data.comment || '';
    const trimmed = text.trim();

    // Must start with ♥
    if (!trimmed.startsWith(TRIGGER_EMOJI)) return;

    const message = trimmed.replace(TRIGGER_EMOJI, '').trim();
    if (!message || message.length < 3) return;

    console.log('[Chat] @' + data.uniqueId + ': ' + message);
    broadcast({
      type: 'message',
      user: data.uniqueId,
      displayName: data.nickname || data.uniqueId,
      text: message,
      gifted: false,
      giftLevel: 'none',
      timestamp: Date.now(),
    });
  });

  // Gift events
  tiktokClient.on('gift', data => {
    // Only fire on gift completion (not streaking)
    if (data.giftType === 1 && !data.repeatEnd) return;

    const giftName = data.giftName || '';
    const diamonds = data.diamondCount || 1;
    const repeatCount = data.repeatCount || 1;
    const totalDiamonds = diamonds * repeatCount;
    const tier = getGiftTier(giftName, totalDiamonds);

    console.log('[Gift] @' + data.uniqueId + ' sent ' + giftName + ' x' + repeatCount + ' (' + totalDiamonds + ' diamonds) -> ' + tier);
    broadcast({
      type: 'gift',
      user: data.uniqueId,
      displayName: data.nickname || data.uniqueId,
      giftName,
      repeatCount,
      diamonds: totalDiamonds,
      tier,
      timestamp: Date.now(),
    });
  });

  // Like events (for engagement tracking)
  tiktokClient.on('like', data => {
    broadcast({ type: 'like', user: data.uniqueId, count: data.likeCount });
  });

  // Viewer count
  tiktokClient.on('roomUser', data => {
    broadcast({ type: 'viewers', count: data.viewerCount });
  });

  // Stream ended
  tiktokClient.on('streamEnd', () => {
    console.log('[TikTok] Stream ended.');
    broadcast({ type: 'stream_end' });
    scheduleReconnect(username);
  });

  // Disconnected
  tiktokClient.on('disconnect', () => {
    console.log('[TikTok] Disconnected.');
    broadcast({ type: 'tiktok_disconnected' });
    scheduleReconnect(username);
  });

  tiktokClient.on('error', err => {
    console.error('[TikTok] Error:', err.message);
  });
}

function scheduleReconnect(username) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log('[TikTok] Reconnecting in 30s...');
  reconnectTimer = setTimeout(() => connectToTikTok(username), 30000);
}

// --- Admin page ---
function buildAdminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UnsentWords Bridge</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#03010c;color:#f6eeff;font-family:'Outfit',sans-serif;padding:32px;min-height:100vh}
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;700&display=swap');
  h1{font-size:22px;font-weight:300;letter-spacing:0.06em;margin-bottom:6px}
  h1 span{color:rgb(218,108,130)}
  .sub{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(246,238,255,0.3);margin-bottom:32px}
  .card{background:rgba(246,238,255,0.04);border:1px solid rgba(246,238,255,0.08);padding:20px 24px;margin-bottom:16px;border-radius:4px}
  .card h2{font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(246,238,255,0.35);margin-bottom:14px}
  .status{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:300}
  .dot{width:8px;height:8px;border-radius:50%;background:rgba(246,238,255,0.2)}
  .dot.green{background:rgba(100,220,160,0.9);box-shadow:0 0 6px rgba(100,220,160,0.5)}
  .dot.red{background:rgba(220,100,100,0.9)}
  .dot.yellow{background:rgba(220,185,100,0.9)}
  input{width:100%;background:rgba(246,238,255,0.05);border:1px solid rgba(246,238,255,0.12);color:#f6eeff;
    font-family:inherit;font-size:13px;padding:10px 14px;outline:none;border-radius:3px;margin-bottom:10px}
  input:focus{border-color:rgba(218,108,130,0.5)}
  input::placeholder{color:rgba(246,238,255,0.25)}
  button{background:rgba(218,108,130,0.15);border:1px solid rgba(218,108,130,0.35);
    color:#f6eeff;font-family:inherit;font-size:11px;letter-spacing:0.2em;
    text-transform:uppercase;padding:10px 20px;cursor:pointer;border-radius:3px;
    transition:all 0.2s;width:100%}
  button:hover{background:rgba(218,108,130,0.28)}
  .log{background:rgba(0,0,0,0.3);border:1px solid rgba(246,238,255,0.06);
    padding:14px;border-radius:3px;height:180px;overflow-y:auto;font-size:11px;
    font-family:'Courier New',monospace;color:rgba(246,238,255,0.5);line-height:1.7}
  .log .msg{color:rgba(218,108,130,0.8)}
  .log .gift{color:rgba(220,185,100,0.8)}
  .log .sys{color:rgba(188,162,255,0.6)}
  .overlay-url{font-size:11px;word-break:break-all;color:rgba(188,162,255,0.7);
    background:rgba(188,162,255,0.08);padding:10px 12px;border-radius:3px;
    border:1px solid rgba(188,162,255,0.15);margin-top:10px;letter-spacing:0.02em}
</style>
</head>
<body>
<h1>Unsent<span>Words</span> Bridge</h1>
<div class="sub">live chat connector</div>

<div class="card">
  <h2>Connection Status</h2>
  <div class="status">
    <div class="dot" id="tikDot"></div>
    <span id="tikStatus">Checking...</span>
  </div>
  <div class="status" style="margin-top:10px">
    <div class="dot" id="wsDot"></div>
    <span id="wsStatus">0 overlay clients connected</span>
  </div>
</div>

<div class="card">
  <h2>TikTok Username</h2>
  <input type="text" id="username" placeholder="@yourusername" value="">
  <button onclick="connect()">Connect to Live</button>
</div>

<div class="card">
  <h2>Overlay URL</h2>
  <p style="font-size:12px;color:rgba(246,238,255,0.4);margin-bottom:8px">Open this URL in your browser while streaming:</p>
  <div class="overlay-url" id="overlayUrl">Loading...</div>
</div>

<div class="card">
  <h2>Live Event Log</h2>
  <div class="log" id="log"><span class="sys">Waiting for events...</span></div>
</div>

<script>
  const ws = new WebSocket('ws://' + location.host);
  const log = document.getElementById('log');
  const tikDot = document.getElementById('tikDot');
  const tikStatus = document.getElementById('tikStatus');
  const wsDot = document.getElementById('wsDot');
  const wsStatus = document.getElementById('wsStatus');

  document.getElementById('overlayUrl').textContent = location.origin + '/overlay';

  function addLog(html) {
    log.innerHTML += '<div>' + html + '</div>';
    log.scrollTop = log.scrollHeight;
  }

  ws.onopen = () => { wsDot.className = 'dot green'; wsStatus.textContent = 'Admin connected'; };
  ws.onclose = () => { wsDot.className = 'dot red'; };
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'tiktok_connected') { tikDot.className='dot green'; tikStatus.textContent='Connected to @'+d.username; addLog('<span class="sys">Connected to @'+d.username+'</span>'); }
    else if (d.type === 'tiktok_disconnected') { tikDot.className='dot red'; tikStatus.textContent='Disconnected'; }
    else if (d.type === 'tiktok_error') { tikDot.className='dot red'; tikStatus.textContent='Error: '+d.message; }
    else if (d.type === 'message') addLog('<span class="msg">@'+d.user+': '+d.text+'</span>');
    else if (d.type === 'gift') addLog('<span class="gift">@'+d.user+' sent '+d.giftName+' x'+d.repeatCount+' ('+d.tier+')</span>');
    else if (d.type === 'viewers') wsStatus.textContent = d.count + ' viewers';
  };

  function connect() {
    const u = document.getElementById('username').value.replace('@','').trim();
    if (!u) return;
    fetch('/connect?username=' + encodeURIComponent(u));
    tikDot.className = 'dot yellow'; tikStatus.textContent = 'Connecting to @'+u+'...';
    addLog('<span class="sys">Connecting to @'+u+'...</span>');
  }

  fetch('/health').then(r=>r.json()).then(d=>{
    if (d.connected) { tikDot.className='dot green'; tikStatus.textContent='Connected to @'+d.username; }
    else { tikDot.className='dot red'; tikStatus.textContent='Not connected'; }
    document.getElementById('username').value = d.username || '';
  });
</script>
</body>
</html>`;
}

// --- Connect endpoint (called from admin panel) ---
const url = require('url');
httpServer._events.request = (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: !!tiktokClient, username: TIKTOK_USERNAME }));
    return;
  }

  if (parsed.pathname === '/connect') {
    const username = parsed.query.username;
    if (username) { connectToTikTok(username); }
    res.writeHead(200); res.end('ok');
    return;
  }

  if (parsed.pathname === '/admin' || parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildAdminPage());
    return;
  }

  res.writeHead(404); res.end();
};

// Auto-connect if username provided via env
if (TIKTOK_USERNAME) connectToTikTok(TIKTOK_USERNAME);

httpServer.listen(PORT, () => {
  console.log('[Server] UnsentWords Bridge running on port ' + PORT);
  console.log('[Server] Admin panel: http://localhost:' + PORT);
});
