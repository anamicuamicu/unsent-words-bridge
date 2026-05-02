
/**
 * UnsentWords — TikTok Chat Bridge
 * Uses tiktok-live-connector v2.x API
 */

const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const { WebSocketServer } = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;
let TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || '';
const TRIGGER = '\u2665'; // ♥

// --- HTTP + WebSocket server ---
const httpServer = http.createServer(handleRequest);
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

wss.on('connection', function(ws) {
  clients.add(ws);
  console.log('[WS] Client connected. Total: ' + clients.size);
  ws.send(JSON.stringify({ type: 'connected', username: TIKTOK_USERNAME }));
  ws.on('close', function() { clients.delete(ws); });
  ws.on('error', function() { clients.delete(ws); });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(function(ws) {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// --- TikTok connection ---
let connection = null;
let reconnectTimer = null;

function getGiftTier(diamonds) {
  if (diamonds >= 50) return 'galaxy';
  if (diamonds >= 5) return 'star';
  return 'rose';
}

function connectTikTok(username) {
  if (!username) return;
  if (connection) {
    try { connection.disconnect(); } catch(e) {}
    connection = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  console.log('[TikTok] Connecting to @' + username + '...');
  connection = new TikTokLiveConnection(username);

  connection.connect().then(function(state) {
    console.log('[TikTok] Connected. Room: ' + state.roomId);
    broadcast({ type: 'tiktok_connected', username: username });
  }).catch(function(err) {
    console.error('[TikTok] Connect failed: ' + err.message);
    broadcast({ type: 'tiktok_error', message: err.message });
    reconnectTimer = setTimeout(function() { connectTikTok(username); }, 30000);
  });

  // ♥ chat messages
  connection.on(WebcastEvent.CHAT, function(data) {
    var comment = (data.comment || '').trim();
    if (!comment.startsWith(TRIGGER)) return;
    var message = comment.slice(1).trim();
    if (!message || message.length < 2) return;
    var user = (data.user && data.user.uniqueId) ? data.user.uniqueId : 'viewer';
    var display = (data.user && data.user.nickname) ? data.user.nickname : user;
    console.log('[Chat] @' + user + ': ' + message);
    broadcast({ type: 'message', user: user, displayName: display, text: message, timestamp: Date.now() });
  });

  // Gift events
  connection.on(WebcastEvent.GIFT, function(data) {
    if (data.giftType === 1 && !data.repeatEnd) return;
    var user = (data.user && data.user.uniqueId) ? data.user.uniqueId : 'viewer';
    var display = (data.user && data.user.nickname) ? data.user.nickname : user;
    var giftName = data.giftName || 'Gift';
    var diamonds = (data.diamondCount || 1) * (data.repeatCount || 1);
    var tier = getGiftTier(diamonds);
    console.log('[Gift] @' + user + ' sent ' + giftName + ' -> ' + tier);
    broadcast({ type: 'gift', user: user, displayName: display, giftName: giftName, repeatCount: data.repeatCount || 1, diamonds: diamonds, tier: tier, timestamp: Date.now() });
  });

  // Viewer count
  connection.on(WebcastEvent.ROOM_USER, function(data) {
    broadcast({ type: 'viewers', count: data.viewerCount });
  });

  // Disconnected
  connection.on(WebcastEvent.DISCONNECT, function() {
    console.log('[TikTok] Disconnected.');
    broadcast({ type: 'tiktok_disconnected' });
    reconnectTimer = setTimeout(function() { connectTikTok(username); }, 30000);
  });
}

// --- HTTP handler ---
function handleRequest(req, res) {
  var parsed = url.parse(req.url, true);

  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: !!connection, username: TIKTOK_USERNAME }));
    return;
  }

  if (parsed.pathname === '/connect') {
    var u = (parsed.query.username || '').replace('@', '').trim();
    if (u) { TIKTOK_USERNAME = u; connectTikTok(u); }
    res.writeHead(200); res.end('ok');
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(adminPage());
    return;
  }

  res.writeHead(404); res.end();
}

function adminPage() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UnsentWords Bridge</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400&display=swap" rel="stylesheet">'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#03010c;color:#f6eeff;font-family:Outfit,sans-serif;padding:28px;min-height:100vh}'
    + 'h1{font-size:20px;font-weight:300;letter-spacing:.06em;margin-bottom:4px}h1 span{color:rgb(218,108,130)}'
    + '.sub{font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:rgba(246,238,255,.3);margin-bottom:28px}'
    + '.card{background:rgba(246,238,255,.04);border:1px solid rgba(246,238,255,.08);padding:18px 20px;margin-bottom:14px;border-radius:4px}'
    + '.card h2{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:rgba(246,238,255,.3);margin-bottom:12px}'
    + '.row{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:200;margin-bottom:8px}'
    + '.dot{width:7px;height:7px;border-radius:50%;background:rgba(246,238,255,.2);flex-shrink:0}'
    + '.green{background:rgba(100,220,160,.9);box-shadow:0 0 5px rgba(100,220,160,.4)}'
    + '.red{background:rgba(220,100,100,.8)}.yellow{background:rgba(220,185,100,.9)}'
    + 'input{width:100%;background:rgba(246,238,255,.05);border:1px solid rgba(246,238,255,.1);color:#f6eeff;'
    + 'font-family:inherit;font-size:13px;padding:9px 12px;outline:none;border-radius:3px;margin-bottom:10px}'
    + 'input:focus{border-color:rgba(218,108,130,.5)}input::placeholder{color:rgba(246,238,255,.2)}'
    + 'button{width:100%;padding:9px;background:rgba(218,108,130,.15);border:1px solid rgba(218,108,130,.3);'
    + 'color:#f6eeff;font-family:inherit;font-size:10px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;border-radius:3px}'
    + 'button:hover{background:rgba(218,108,130,.25)}'
    + '.log{background:rgba(0,0,0,.3);border:1px solid rgba(246,238,255,.06);padding:12px;border-radius:3px;'
    + 'height:160px;overflow-y:auto;font-size:11px;font-family:monospace;color:rgba(246,238,255,.45);line-height:1.7}'
    + '.m{color:rgba(218,108,130,.8)}.g{color:rgba(220,185,100,.8)}.s{color:rgba(188,162,255,.6)}'
    + '.url{font-size:11px;word-break:break-all;color:rgba(188,162,255,.7);background:rgba(188,162,255,.07);'
    + 'padding:9px 11px;border-radius:3px;border:1px solid rgba(188,162,255,.12);margin-top:8px}'
    + '</style></head><body>'
    + '<h1>Unsent<span>Words</span></h1><div class="sub">bridge server</div>'
    + '<div class="card"><h2>Status</h2>'
    + '<div class="row"><div class="dot" id="td"></div><span id="ts">checking...</span></div>'
    + '<div class="row"><div class="dot" id="wd"></div><span id="ws">0 overlay clients</span></div></div>'
    + '<div class="card"><h2>Connect</h2>'
    + '<input id="un" placeholder="your TikTok username (no @)" value=""><button onclick="go()">Connect to Live</button></div>'
    + '<div class="card"><h2>Overlay URL — open this while streaming</h2>'
    + '<div class="url" id="ou">loading...</div></div>'
    + '<div class="card"><h2>Event Log</h2><div class="log" id="log"><span class="s">waiting...</span></div></div>'
    + '<script>'
    + 'var wsProto=location.protocol==="https:"?"wss:":"ws:";'
    + 'var ws=new WebSocket(wsProto+"//"+location.host);'
    + 'document.getElementById("ou").textContent=location.origin;'
    + 'var log=document.getElementById("log"),td=document.getElementById("td"),ts=document.getElementById("ts");'
    + 'var wd=document.getElementById("wd");'
    + 'function addLog(h){log.innerHTML+="<div>"+h+"</div>";log.scrollTop=log.scrollHeight;}'
    + 'ws.onopen=function(){wd.className="dot green";};'
    + 'ws.onclose=function(){wd.className="dot red";};'
    + 'ws.onmessage=function(e){'
    + 'var d=JSON.parse(e.data);'
    + 'if(d.type==="tiktok_connected"){td.className="dot green";ts.textContent="Live: @"+d.username;addLog("<span class=s>connected @"+d.username+"</span>");}'
    + 'else if(d.type==="tiktok_disconnected"){td.className="dot red";ts.textContent="disconnected";}'
    + 'else if(d.type==="tiktok_error"){td.className="dot red";ts.textContent="error: "+d.message;addLog("<span class=s>error: "+d.message+"</span>");}'
    + 'else if(d.type==="message")addLog("<span class=m>@"+d.user+": "+d.text+"</span>");'
    + 'else if(d.type==="gift")addLog("<span class=g>@"+d.user+" gift: "+d.giftName+" ("+d.tier+")</span>");'
    + 'else if(d.type==="viewers")wd.nextElementSibling.textContent=d.count+" viewers";'
    + '};'
    + 'function go(){'
    + 'var u=document.getElementById("un").value.replace("@","").trim();'
    + 'if(!u)return;'
    + 'td.className="dot yellow";ts.textContent="connecting...";'
    + 'addLog("<span class=s>connecting to @"+u+"...</span>");'
    + 'fetch("/connect?username="+encodeURIComponent(u));'
    + '}'
    + 'fetch("/health").then(function(r){return r.json();}).then(function(d){'
    + 'if(d.username)document.getElementById("un").value=d.username;'
    + 'if(d.connected){td.className="dot green";ts.textContent="Live: @"+d.username;}'
    + 'else{td.className="dot red";ts.textContent="not connected";}'
    + '});'
    + '</script></body></html>';
}

// Start
httpServer.listen(PORT, function() {
  console.log('[Server] Running on port ' + PORT);
  if (TIKTOK_USERNAME) connectTikTok(TIKTOK_USERNAME);
});
