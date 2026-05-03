const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
let TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const SYS_PROMPT = "You are a calm, wise, deeply caring presence answering questions people are afraid to ask out loud. Someone is asking something they have carried for a long time. Rules: Always directly answer the question being asked. Your answer must clearly relate to the intent of the question. Keep answers to 1 to 2 sentences max. Tone: calm, wise, slightly poetic but still clear and understandable. Speak as if you are reassuring or gently guiding the person. Make the answer feel powerful and quotable. Examples: Q: Am I enough? A: You have always been enough, even in the moments when you doubted it most. Q: Will I succeed? A: Yes, if you keep going, your effort will shape the outcome you are hoping for. Q: Why do I feel lost? A: You are in a transition not a failure, this feeling is part of finding your direction. Q: where are you now? A: I am closer than you think, in the quiet moments when you feel something you cannot name. Q: do you miss me? A: Every single day, more than words have ever been able to hold. Return only the reply. No quotes, no labels, no extra text.";

// --- Claude API call ---
function callClaude(system, userMsg, maxTokens, callback) {
  var body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system: system,
    messages: [{ role: 'user', content: userMsg }]
  });
  var options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  var req = https.request(options, function(res) {
    var data = '';
    res.on('data', function(chunk) { data += chunk; });
    res.on('end', function() {
      try { callback(null, JSON.parse(data)); }
      catch(e) { callback(e); }
    });
  });
  req.on('error', callback);
  req.write(body);
  req.end();
}

// --- HTTP server ---
const httpServer = http.createServer(handleRequest);

// --- WebSocket server ---
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

// --- TikTok ---
let connection = null;
let reconnectTimer = null;

function getGiftTier(diamonds) {
  if (diamonds >= 50) return 'galaxy';
  if (diamonds >= 5) return 'star';
  return 'rose';
}

function connectTikTok(username) {
  if (!username) return;
  if (connection) { try { connection.disconnect(); } catch(e) {} connection = null; }
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

  // Chat messages — no filter, all messages go through
  connection.on(WebcastEvent.CHAT, function(data) {
    var comment = (data.comment || '').trim();
    if (!comment) return;
    var user = (data.user && data.user.uniqueId) ? data.user.uniqueId : 'viewer';
    var display = (data.user && data.user.nickname) ? data.user.nickname : user;
    console.log('[Chat] @' + user + ': ' + comment);
    broadcast({ type: 'message', user: user, displayName: display, text: comment, timestamp: Date.now() });
  });

  connection.on(WebcastEvent.GIFT, function(data) {
    if (data.giftType === 1 && !data.repeatEnd) return;
    var user = (data.user && data.user.uniqueId) ? data.user.uniqueId : 'viewer';
    var display = (data.user && data.user.nickname) ? data.user.nickname : user;
    var giftName = data.giftName || 'Gift';
    var diamonds = (data.diamondCount || 1) * (data.repeatCount || 1);
    var tier = getGiftTier(diamonds);
    broadcast({ type: 'gift', user: user, displayName: display, giftName: giftName, repeatCount: data.repeatCount || 1, diamonds: diamonds, tier: tier, timestamp: Date.now() });
  });

  connection.on(WebcastEvent.ROOM_USER, function(data) {
    broadcast({ type: 'viewers', count: data.viewerCount });
  });

  connection.on(WebcastEvent.DISCONNECT, function() {
    console.log('[TikTok] Disconnected.');
    broadcast({ type: 'tiktok_disconnected' });
    reconnectTimer = setTimeout(function() { connectTikTok(username); }, 30000);
  });
}

// --- HTTP handler ---
function handleRequest(req, res) {
  var parsed = url.parse(req.url, true);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

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

  if (parsed.pathname === '/reply') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var msg = data.message || '';
        callClaude(SYS_PROMPT, msg, 80, function(err, result) {
          var reply = '';
          if (!err && result && result.content && result.content[0]) {
            reply = result.content[0].text.trim().replace(/^["']|["']$/g, '');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply: reply }));
        });
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ reply: '' }));
      }
    });
    return;
  }

  if (parsed.pathname === '/fixtypos') {
    var body2 = '';
    req.on('data', function(chunk) { body2 += chunk; });
    req.on('end', function() {
      try {
        var data2 = JSON.parse(body2);
        var text = data2.text || '';
        callClaude('Fix spelling mistakes and typos only. Keep the exact meaning and words. Return only the corrected text, no explanation.', text, 60, function(err, result) {
          var fixed = text;
          if (!err && result && result.content && result.content[0]) {
            fixed = result.content[0].text.trim();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: fixed }));
        });
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ result: '' }));
      }
    });
    return;
  }

  if (parsed.pathname === '/test') {
    broadcast({ type: 'message', user: 'test', displayName: 'test', text: 'Am I enough?', timestamp: Date.now() });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#03010c;color:#f6eeff;font-family:sans-serif;padding:40px"><h2>Test message sent</h2><a href="/" style="color:rgba(218,108,130,0.8)">Back to admin</a></body></html>');
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
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>UnsentWords Bridge</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400&display=swap" rel="stylesheet">'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#03010c;color:#f6eeff;font-family:Outfit,sans-serif;padding:28px}'
    + 'h1{font-size:20px;font-weight:300;margin-bottom:4px}h1 span{color:rgb(218,108,130)}'
    + '.sub{font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:rgba(246,238,255,.3);margin-bottom:28px}'
    + '.card{background:rgba(246,238,255,.04);border:1px solid rgba(246,238,255,.08);padding:18px 20px;margin-bottom:14px;border-radius:4px}'
    + '.card h2{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:rgba(246,238,255,.3);margin-bottom:12px}'
    + '.row{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:200;margin-bottom:8px}'
    + '.dot{width:7px;height:7px;border-radius:50%;background:rgba(246,238,255,.2);flex-shrink:0}'
    + '.green{background:rgba(100,220,160,.9)}.red{background:rgba(220,100,100,.8)}.yellow{background:rgba(220,185,100,.9)}'
    + 'input{width:100%;background:rgba(246,238,255,.05);border:1px solid rgba(246,238,255,.1);color:#f6eeff;font-family:inherit;font-size:13px;padding:9px 12px;outline:none;border-radius:3px;margin-bottom:10px}'
    + 'button{width:100%;padding:9px;background:rgba(218,108,130,.15);border:1px solid rgba(218,108,130,.3);color:#f6eeff;font-family:inherit;font-size:10px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;border-radius:3px}'
    + '.log{background:rgba(0,0,0,.3);border:1px solid rgba(246,238,255,.06);padding:12px;border-radius:3px;height:160px;overflow-y:auto;font-size:11px;font-family:monospace;color:rgba(246,238,255,.45);line-height:1.7}'
    + '.m{color:rgba(218,108,130,.8)}.s{color:rgba(188,162,255,.6)}</style></head><body>'
    + '<h1>Unsent<span>Words</span></h1><div class="sub">bridge server</div>'
    + '<div class="card"><h2>Status</h2>'
    + '<div class="row"><div class="dot" id="td"></div><span id="ts">checking...</span></div>'
    + '<div class="row"><div class="dot" id="wd"></div><span id="ws">0 clients</span></div></div>'
    + '<div class="card"><h2>Connect TikTok</h2>'
    + '<input id="un" placeholder="your TikTok username (no @)"><button onclick="go()">Connect to Live</button></div>'
    + '<div class="card"><h2>Test</h2><button onclick="fetch(\'/test\')">Send test message to overlay</button></div>'
    + '<div class="card"><h2>Event Log</h2><div class="log" id="log"><span class="s">waiting...</span></div></div>'
    + '<script>var wsProto=location.protocol==="https:"?"wss:":"ws:";'
    + 'var ws=new WebSocket(wsProto+"//"+location.host);'
    + 'var log=document.getElementById("log"),td=document.getElementById("td"),ts=document.getElementById("ts"),wd=document.getElementById("wd");'
    + 'function addLog(h){log.innerHTML+="<div>"+h+"</div>";log.scrollTop=log.scrollHeight;}'
    + 'ws.onopen=function(){wd.className="dot green";};ws.onclose=function(){wd.className="dot red";};'
    + 'ws.onmessage=function(e){var d=JSON.parse(e.data);'
    + 'if(d.type==="tiktok_connected"){td.className="dot green";ts.textContent="Live: @"+d.username;addLog("<span class=s>connected @"+d.username+"</span>");}'
    + 'else if(d.type==="tiktok_disconnected"){td.className="dot red";ts.textContent="disconnected";}'
    + 'else if(d.type==="message")addLog("<span class=m>@"+d.user+": "+d.text+"</span>");};'
    + 'function go(){var u=document.getElementById("un").value.replace("@","").trim();if(!u)return;'
    + 'td.className="dot yellow";ts.textContent="connecting...";fetch("/connect?username="+encodeURIComponent(u));}'
    + 'fetch("/health").then(function(r){return r.json();}).then(function(d){'
    + 'if(d.username)document.getElementById("un").value=d.username;'
    + 'if(d.connected){td.className="dot green";ts.textContent="Live: @"+d.username;}else{td.className="dot red";ts.textContent="not connected";}});'
    + '</script></body></html>';
}

// Start
httpServer.listen(PORT, function() {
  console.log('[Server] Running on port ' + PORT);
  if (TIKTOK_USERNAME) connectTikTok(TIKTOK_USERNAME);
});
