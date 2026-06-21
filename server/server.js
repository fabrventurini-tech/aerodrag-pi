/**
 * AeroDrag Coach Server v4 — multi-atleta
 * Gestisce sessioni separate per device ID.
 * Ogni device si identifica con { device: "AA:BB:CC:DD:EE:FF", athlete: "Mario" }
 *
 * Contract: v0.3.0 — fonte di verità in aerodrag-firmware/docs/CONTRACT.md
 *   Frame telemetria atteso a 2 Hz; pctAero in percentuale 0-100;
 *   campi pitch/rho/lapEvent presenti nel frame e registrati nelle sessioni.
 *   §3: `device` obbligatorio e MAC-valido → frame senza identità rifiutati
 *   all'ingestione. §5: filename sessione sempre session_{ts}_{deviceIdHex}.json.
 *   v0.3.0: /device è l'uplink primario (ESP32); /coach resta accettato come
 *   fallback legacy DEPRECATO (non rimuovere). Frame `tUtc` (epoch UTC) additivo:
 *   il `ts` di sessione deriva da tUtc se >0, altrimenti dal tempo del Pi.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT         = parseInt(process.env.PORT || '8080');
const USB_IP       = process.env.USB_IP  || '192.168.7.1';
const WIFI_IP      = process.env.WIFI_IP || '192.168.8.1';
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PENDING_FILE = path.join(SESSIONS_DIR, '_pending.json');
// PC_IP: indirizzo riservato per il PC coach sulla rete USB. setup.sh configura
// il DHCP del Pi (range .2–.10) con .2 come PRIMO indirizzo assegnato → riservato
// al PC coach. Se il PC ottiene un IP diverso, il push live (sendToPc) non arriva
// ma il pc-receiver fa comunque il pull da /api/sessions (recupero). v0.3.0 audit #16.
const PC_IP        = process.env.PC_IP || '192.168.7.2';
const PC_PORT      = 8081;

// Contract §3 (v0.1.2): il campo `device` dei frame DEVE essere un MAC valido
// (6 ottetti esadecimali separati da ':'). È la chiave di sessione e l'identità
// alla sorgente: i frame che non lo rispettano vengono rifiutati all'ingestione.
const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Pending queue ────────────────────────────────────────────────────────────
function pendingLoad() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return []; }
}
function pendingSave(list) { fs.writeFileSync(PENDING_FILE, JSON.stringify(list)); }
function pendingAdd(filename) {
  const list = pendingLoad();
  if (!list.includes(filename)) { list.push(filename); pendingSave(list); }
}
function pendingRemove(filename) { pendingSave(pendingLoad().filter(f => f !== filename)); }

// ─── Multi-atleta: una sessione per device ────────────────────────────────────
// sessions: Map<deviceId, sessionData>
const sessions = new Map();

function sessionStart(deviceId, athleteName) {
  if (sessions.has(deviceId)) {
    const existing = sessions.get(deviceId);
    // Riconnessione WiFi rapida (< 5 min dall'ultimo frame): riprendi la
    // sessione esistente senza spezzarla in più file
    if (existing.lastSeen && Date.now() - existing.lastSeen < 5 * 60_000) {
      existing.athleteName = athleteName || existing.athleteName;
      console.log(`[pi] Sessione ripresa: ${existing.athleteName} (${deviceId})`);
      return;
    }
    // Sessione vecchia (uscita precedente): salvala se ha abbastanza dati
    if (existing.frameCount >= 20) {
      console.log(`[pi] Riconnessione device — salvo sessione precedente (${existing.frameCount} frame)`);
      sessionEnd(deviceId);   // salva e poi sessions.delete avviene dentro
    } else {
      sessions.delete(deviceId);   // sessione troppo breve, scarta
    }
  }
  sessions.set(deviceId, {
    deviceId, athleteName,
    startTs: Date.now(), lastSeen: Date.now(), laps: {}, lapNotes: {}, frameCount: 0,
  });
  console.log(`[pi] Sessione avviata: ${athleteName} (${deviceId})`);
}

function sessionAddFrame(frame) {
  // Fix S5: ignora frame con CdA non valido (undefined, null, NaN, Infinity)
  // Evita propagazione di NaN nelle statistiche cumulate
  if (typeof frame.CdA !== 'number' || !isFinite(frame.CdA)) return;
  if (frame.CdA < 0.05 || frame.CdA > 1.0) return;   // fuori range fisico → scarta

  // Contract §3 (v0.1.2): `device` obbligatorio e MAC-valido. Rifiuta
  // all'ingestione i frame senza identità valida (come per il CdA fuori range):
  // così una sessione senza deviceId valido non si forma mai (§5).
  if (typeof frame.device !== 'string' || !MAC_RE.test(frame.device)) return;

  const deviceId = frame.device;
  if (!sessions.has(deviceId)) {
    // v0.3.0 audit #16: niente sessioni fantasma — crea solo se il device è
    // effettivamente connesso (in deviceWsMap). Evita che un frame in coda
    // (race con ws close) o senza hello materializzi una sessione orfana.
    const connected = [...deviceWsMap.values()].some(i => i.deviceId === deviceId);
    if (!connected) return;
    sessionStart(deviceId, frame.athlete || 'Atleta');
  }
  const sess = sessions.get(deviceId);
  // Contract v0.3.0 §3/§5: timestamp oggettivo. Memorizza il primo `tUtc` valido
  // (epoch UTC ms; soglia 2020 = 1577836800000, altrimenti orologio non impostato)
  // → base del `ts` di sessione per ordinamento/dedup assoluti; fallback a serverTs.
  if (!sess.tsUtc && typeof frame.tUtc === 'number' && frame.tUtc >= 1577836800000) sess.tsUtc = frame.tUtc;
  // v0.3.0 audit #16: ancora i tempi del lap al serverTs (wall-clock del Pi), non a
  // frame.t (ms-da-boot): robusto al reboot del device (niente `s` negativi/azzerati).
  const tRef = frame.serverTs || Date.now();
  const lap  = frame.lap || 1;
  if (!sess.laps[lap])
    sess.laps[lap] = { n:0, sumCdA:0, sumPwr:0, sumSpd:0, sumHr:0,
                       sumWind:0, sumCad:0, startTs:tRef, pts:[] };
  const lp = sess.laps[lap];
  lp.n++; lp.sumCdA+=frame.CdA; lp.sumPwr+=(frame.pwr||0);
  lp.sumSpd+=(frame.spd||0); lp.sumHr+=(frame.hr||0);
  lp.sumWind+=(frame.wind||0); lp.sumCad+=(frame.cad||0);
  // Campiona 1 punto ogni 5 frame includendo il PRIMO (n=1 → s≈0): (n-1)%5
  if ((lp.n - 1) % 5 === 0 && lp.pts.length < 2000)   // cap 2000 pt/lap
    lp.pts.push({ s:Math.round((tRef-lp.startTs)/1000),
      CdA:+frame.CdA.toFixed(4), pwr:frame.pwr||0, spd:+(frame.spd||0).toFixed(1),
      hr:frame.hr||0, wind:+(frame.wind||0).toFixed(2), cad:frame.cad||0,
      pitch:+(frame.pitch||0).toFixed(1), rho:+(frame.rho||0).toFixed(4) });
  sess.frameCount++;
  sess.lastSeen = Date.now();
}

function sessionSetNote(deviceId, lapNum, text) {
  const sess = sessions.get(deviceId);
  if (sess) sess.lapNotes[lapNum] = text;
}

function sessionEnd(deviceId) {
  const sess = sessions.get(deviceId);
  if (!sess || sess.frameCount < 20) { sessions.delete(deviceId); return; }
  const { startTs, athleteName, laps, lapNotes } = sess;
  // Contract v0.3.0 §5: il `ts` di sessione deriva dal `tUtc` del device (epoch UTC)
  // quando disponibile (>0), così è ordinabile/deduplicabile in assoluto; altrimenti
  // fallback al tempo del Pi (startTs ≈ serverTs). Formato filename §5 invariato.
  const sessionTs = sess.tsUtc > 0 ? sess.tsUtc : startTs;
  const lapNs = Object.keys(laps).map(Number).sort((a,b)=>a-b);
  const lapData = lapNs.map(n => {
    const lp = laps[n];
    return {
      lapNum:n, startTs:lp.startTs,
      durationS:   lp.pts.length ? lp.pts[lp.pts.length-1].s : 0,
      avgCdA:      +(lp.sumCdA/lp.n).toFixed(4),
      // Fix S3: Math.min(...arr) può causare stack overflow con array grandi
      bestCdA:     lp.pts.length ? +(lp.pts.reduce((m,p)=>p.CdA<m?p.CdA:m, Infinity)).toFixed(4) : 0,
      avgPowerW:   Math.round(lp.sumPwr/lp.n),
      avgSpeedKmh: +(lp.sumSpd/lp.n).toFixed(1),
      avgHr:       Math.round(lp.sumHr/lp.n)||0,
      avgCad:      Math.round(lp.sumCad/lp.n)||0,
      avgWindMs:   +(lp.sumWind/lp.n).toFixed(2),
      notes:       lapNotes[n]||'', pts: lp.pts,
    };
  });
  // Nome file con deviceId per evitare collisioni tra atleti
  // Fix P2: sanitizzazione stringente — solo hex e ':' ammessi nel device_id,
  // tutti gli altri caratteri rimossi. Previene path traversal anche se un device
  // malevolo si presenta con un ID arbitrario via BLE → snprintf JSON.
  // Contract §5 (v0.1.2): filename SEMPRE `session_{ts}_{deviceIdHex}.json`.
  // La validazione MAC alla sorgente (§3, sessionAddFrame) garantisce che ogni
  // sessione abbia un deviceId valido → safeId è sempre hex non vuoto; niente
  // token `unknown` né forma anonima senza suffisso.
  const safeId   = deviceId.replace(/:/g, '');
  const filename = `session_${sessionTs}_${safeId}.json`;
  const json     = JSON.stringify({ ts:sessionTs, deviceId, athleteName, laps:lapData }, null, 2);
  fs.writeFile(path.join(SESSIONS_DIR, filename), json, err => {
    if (err) { console.error('[pi] Errore salvataggio:', err.message); sessions.delete(deviceId); return; }
    console.log(`[pi] Sessione salvata: ${athleteName} → ${filename}`);
    sendToPc(filename, json, ok => { if (!ok) pendingAdd(filename); });
  });
  broadcast({ type:'session_saved', filename, deviceId, athleteName, ts:sessionTs, lapCount:lapData.length });
  sessions.delete(deviceId);
}

// ─── Invio PC + sync ──────────────────────────────────────────────────────────
function sendToPc(filename, json, callback) {
  const options = {
    hostname:PC_IP, port:PC_PORT,
    path:`/receive?filename=${encodeURIComponent(filename)}`,
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(json) },
    timeout:6000,
  };
  const req = http.request(options, res => {
    const ok = res.statusCode === 200;
    if (ok) { pendingRemove(filename); broadcast({ type:'session_synced', filename }); }
    callback && callback(ok);
  });
  req.on('error', () => callback && callback(false));
  req.on('timeout', () => { req.destroy(); callback && callback(false); });
  req.write(json); req.end();
}

function syncPending() {
  const pending = pendingLoad();
  if (!pending.length) return;
  let i = 0;
  function next() {
    if (i >= pending.length) { broadcast({ type:'sync_complete', synced:i }); return; }
    const filename = pending[i++];
    try {
      const json = fs.readFileSync(path.join(SESSIONS_DIR, filename), 'utf8');
      sendToPc(filename, json, ok => {
        if (ok) broadcast({ type:'sync_progress', filename, remaining:pending.length-i });
        setTimeout(next, ok ? 500 : 2000);
      });
    } catch { pendingRemove(filename); setTimeout(next, 100); }
  }
  next();
}

function probePc() {
  const pending = pendingLoad();
  if (!pending.length) return;
  const req = http.request({ hostname:PC_IP, port:PC_PORT, path:'/ping', method:'GET', timeout:3000 }, res => {
    if (res.statusCode === 200) syncPending();
  });
  req.on('error', () => {}); req.on('timeout', () => req.destroy()); req.end();
}
setInterval(probePc, 60_000);
setTimeout(probePc, 5000);

// Cache per /api/sessions (v0.3.0 audit #16): evita readFileSync+JSON.parse di
// fino a 100 file ad ogni richiesta (freeze su Pi Zero 2W). Ricostruita solo
// quando cambia l'insieme dei file; `synced` (dipende da pending) si ricalcola.
let sessionsCacheSig = '', sessionsCacheBuilt = [];

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/' || url === '/dashboard') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
      return res.end(html);
    } catch { res.writeHead(500); return res.end('dashboard.html mancante'); }
  }

  if (url === '/status') {
    const pending = pendingLoad();
    const athletes = [...deviceWsMap.values()].map(s => ({ deviceId:s.deviceId, athleteName:s.athleteName }));
    res.writeHead(200, { 'Content-Type':'application/json' });
    return res.end(JSON.stringify({
      athletes, coaches:coachClients.size, frames:frameCount,
      pendingSync:pending.length,
    }));
  }

  if (url === '/api/pending') {
    res.writeHead(200, { 'Content-Type':'application/json' });
    return res.end(JSON.stringify(pendingLoad()));
  }

  if (url === '/api/sessions') {
    try {
      const files = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json') && f !== '_pending.json')
        .sort().reverse().slice(0, 100);
      const sig = files.join('|');
      if (sig !== sessionsCacheSig) {   // ricostruisci solo se l'insieme file è cambiato
        sessionsCacheBuilt = files.map(f => {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
            return {
              file:f, id:f.replace('.json',''), ts:d.ts,
              date:new Date(d.ts).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}),
              time:new Date(d.ts).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}),
              deviceId:d.deviceId||'', athleteName:d.athleteName||'Atleta',
              lapCount:d.laps?.length||0,
              laps:(d.laps||[]).map(l=>({
                lapNum:l.lapNum, avgCdA:l.avgCdA, bestCdA:l.bestCdA,
                avgPowerW:l.avgPowerW, avgSpeedKmh:l.avgSpeedKmh,
                avgHr:l.avgHr, avgCad:l.avgCad, durationS:l.durationS, notes:l.notes,
              })),
            };
          } catch { return null; }
        }).filter(Boolean);
        sessionsCacheSig = sig;
      }
      const pending = pendingLoad();
      const list = sessionsCacheBuilt.map(({ file, ...rest }) => ({ ...rest, synced:!pending.includes(file) }));
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify(list));
    } catch { res.writeHead(500); return res.end('[]'); }
  }

  // OTA firmware: l'ESP32 scarica il binario da questo endpoint
  // Il file fw.bin va copiato in /home/pi/aerodrag/fw.bin prima di inviare il cmd ota
  if (url === '/fw.bin') {
    const fwPath = path.join(__dirname, 'fw.bin');
    try {
      const stat = fs.statSync(fwPath);
      res.writeHead(200, {
        'Content-Type':   'application/octet-stream',
        'Content-Length': stat.size,
      });
      return fs.createReadStream(fwPath).pipe(res);
    } catch {
      res.writeHead(404); return res.end('fw.bin non trovato');
    }
  }

  const m = url.match(/^\/api\/sessions\/(.+)$/);
  if (m) {
    // Fix S2: valida pattern session_DDDDDDDD_HEX prima di path.join — previene path traversal
    // Contract §5 (v0.1.2+): suffisso deviceId OBBLIGATORIO (no forma anonima session_{ts})
    if (!/^session_\d+_[A-Fa-f0-9]+$/.test(m[1])) {
      res.writeHead(400); return res.end('invalid id');
    }
    try {
      const data = fs.readFileSync(path.join(SESSIONS_DIR, m[1]+'.json'), 'utf8');
      res.writeHead(200, { 'Content-Type':'application/json' }); return res.end(data);
    } catch { res.writeHead(404); return res.end('{}'); }
  }

  res.writeHead(404); res.end();
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
// deviceWsMap: Map<ws → { deviceId, athleteName }>
const deviceWsMap  = new Map();
const coachClients = new Set();
// lastFrameByDevice: Map<deviceId → frame> — per late-join dei coach
const lastFrameByDevice = new Map();
// frameHistory: Map<deviceId → frame[]> — buffer frame recenti per il messaggio
// 'history' inviato ai coach che si connettono a sessione già in corso
const frameHistory = new Map();
const HISTORY_MAX  = 100;   // ~10s a 10Hz per device
let frameCount = 0;

function broadcast(msg) {
  const json = JSON.stringify(msg);
  coachClients.forEach(c => { if (c.readyState === 1) c.send(json); });
}

wss.on('connection', (ws, req) => {
  const url      = req.url || '/';
  const ip       = req.socket.remoteAddress;

  if (url === '/device' || url === '/coach') {
    // ── Sorgente telemetria atleta (contract v0.1.0, confini B/C + D) ──
    //   /device = firmware ESP32 in WiFi diretto (confine B)
    //   /coach  = app atleta (aerodrag-new) che fa da relay BLE (confine C)
    // Entrambe inviano hello + frame JSON e ricevono i comandi start/stop/lap.
    console.log(`[${url === '/coach' ? 'app' : 'device'}] connesso da ${ip}`);

    ws.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'hello') {
          // hello: { type:'hello', device:'AA:BB:...', athlete:'Mario', fw:'1.3.0' }
          // Contract §3: `device` obbligatorio e MAC-valido. Niente fallback su
          // `ip` (sarebbe un'identità anonima/non-MAC): hello senza MAC valido
          // viene ignorato, coerente con la validazione dei frame all'ingestione.
          if (typeof frame.device !== 'string' || !MAC_RE.test(frame.device)) return;
          const devId = frame.device;
          const name  = frame.athlete || 'Atleta';
          const fw    = frame.fw || '';
          deviceWsMap.set(ws, { deviceId: devId, athleteName: name, fw });
          sessionStart(devId, name);
          broadcast({ type:'device_connected', deviceId:devId, athleteName:name, fw, ip });
          // Notifica lista atleti connessi
          broadcast({ type:'athletes', list:[...deviceWsMap.values()] });
          return;
        }
        if (frame.type === 'ping') return;

        const devInfo = deviceWsMap.get(ws) || { athleteName:'Atleta' };
        frame.device  = frame.device  || devInfo.deviceId;
        frame.athlete = frame.athlete || devInfo.athleteName;

        // Contract §3 (v0.3.0, audit #16): rifiuta all'ingestione OGNI frame senza
        // `device` MAC valido, PRIMA di qualsiasi broadcast/buffer/sessione. Evita
        // sessioni anonime e relay/history con chiave 'unknown'.
        if (typeof frame.device !== 'string' || !MAC_RE.test(frame.device)) return;

        // Aggiorna il nome se l'app lo ha impostato dopo il hello
        if (frame.athlete && frame.athlete !== devInfo.athleteName) {
          devInfo.athleteName = frame.athlete;
          const sess = sessions.get(devInfo.deviceId);
          if (sess) sess.athleteName = frame.athlete;
          broadcast({ type:'athlete_update', deviceId:devInfo.deviceId, athleteName:frame.athlete });
        }

        // serverTs: il t del device è ms dal boot, non epoch — questo è
        // l'unico timestamp assoluto affidabile (aggiunto prima di inoltro e salvataggio)
        frame.serverTs = Date.now();

        frameCount++;
        sessionAddFrame(frame);
        // lapEvent:true → notifica la dashboard del cambio lap (l'ESP32 lo manda una sola volta)
        if (frame.lapEvent === true) {
          broadcast({ type:'lap_event', deviceId:frame.device, lap:frame.lap });
        }
        lastFrameByDevice.set(frame.device, frame);
        // Buffer history per late-join dei coach
        let hist = frameHistory.get(frame.device);
        if (!hist) { hist = []; frameHistory.set(frame.device, hist); }
        hist.push(frame);
        if (hist.length > HISTORY_MAX) hist.shift();

        const json = JSON.stringify(frame);
        coachClients.forEach(c => { if (c.readyState === 1) c.send(json); });

      } catch (e) { console.error('[relay] error:', e.message); }
    });

    ws.on('close', () => {
      const devInfo = deviceWsMap.get(ws);
      if (devInfo) {
        console.log(`[device] disconnesso: ${devInfo.athleteName}`);
        deviceWsMap.delete(ws);
        // Se lo stesso device si è già riconnesso con un'altra ws (riconnessione
        // WiFi), non toccare la sessione attiva della nuova connessione
        const stillConnected = [...deviceWsMap.values()].some(i => i.deviceId === devInfo.deviceId);
        if (!stillConnected) {
          sessionEnd(devInfo.deviceId);
          lastFrameByDevice.delete(devInfo.deviceId);
          frameHistory.delete(devInfo.deviceId);
          broadcast({ type:'device_disconnected', deviceId:devInfo.deviceId });
        }
        broadcast({ type:'athletes', list:[...deviceWsMap.values()] });
      }
    });
    ws.on('error', () => {});

  } else if (url === '/') {
    // ── Dashboard coach (browser Pi + Electron) — sola visualizzazione (confine D) ──
    coachClients.add(ws);
    console.log(`[coach] connesso da ${ip} · totale=${coachClients.size}`);

    // History: buffer frame recenti di tutti i device per ripopolare i grafici
    const allFrames = [];
    frameHistory.forEach(hist => allFrames.push(...hist));
    if (allFrames.length)
      ws.send(JSON.stringify({ type:'history', frames:allFrames }));
    // Invia lista atleti correnti
    ws.send(JSON.stringify({ type:'athletes', list:[...deviceWsMap.values()] }));
    // Stato sync
    const pending = pendingLoad();
    if (pending.length)
      ws.send(JSON.stringify({ type:'sync_status', pending:pending.length }));

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'cmd') {
          // Whitelist rigida: solo questi action esatti raggiungono il device.
          // Il firmware fa parsing a strstr sui primi 127 byte — mai passthrough.
          if (!['lap','start','stop','ota'].includes(msg.action)) return;
          const targetDevId = msg.deviceId;   // può essere undefined = broadcast a tutti
          if (msg.action === 'ota') {
            // ota richiede url; rifiuta URL con sottostringhe che il parser strstr
            // del firmware scambierebbe per comandi (ultima linea di difesa)
            if (!msg.url || typeof msg.url !== 'string' ||
                msg.url.includes('lap') || msg.url.includes('stop')) {
              ws.send(JSON.stringify({ type:'cmd_error', action:msg.action,
                deviceId:targetDevId, reason:'ota_invalid_url' }));
              return;
            }
          }
          // Riscrittura: payload minimo, senza deviceId (serve solo al routing del Pi)
          const payload = { type:'cmd', action:msg.action };
          if (msg.action === 'ota') payload.url = msg.url;
          const payloadJson = JSON.stringify(payload);
          if (payloadJson.length > 127) {   // il firmware ignora frame oltre 127 byte
            ws.send(JSON.stringify({ type:'cmd_error', action:msg.action,
              deviceId:targetDevId, reason:'payload_too_long' }));
            return;
          }
          let sent = 0;
          deviceWsMap.forEach((info, devWs) => {
            if (!targetDevId || info.deviceId === targetDevId) {
              if (devWs.readyState === 1) {
                devWs.send(payloadJson);
                sent++;
              }
            }
          });
          if (sent === 0) {
            ws.send(JSON.stringify({ type:'cmd_error', action:msg.action,
              deviceId:targetDevId, reason:'device_not_connected' }));
            return;
          }
          broadcast({ type:'cmd_echo', action:msg.action, deviceId:targetDevId });
        }
        if (msg.type === 'lap_note') {
          // Contract §3/§4: nessuna identità anonima. Senza deviceId MAC-valido
          // la nota non è attribuibile a una sessione → ignorala (niente
          // fallback 'unknown', niente relay).
          if (typeof msg.deviceId !== 'string' || !MAC_RE.test(msg.deviceId)) return;
          sessionSetNote(msg.deviceId, msg.lapNum, msg.text);
          const json = JSON.stringify(msg);
          coachClients.forEach(c => { if (c !== ws && c.readyState === 1) c.send(json); });
        }
        if (msg.type === 'sync_now') syncPending();
      } catch {}
    });

    ws.on('close', () => { coachClients.delete(ws); });
    ws.on('error', () => {});
  } else {
    ws.close(1008, 'invalid path');
  }
});

// Heartbeat — coach a 2s (misura latenza dashboard), device a 15s (keepalive)
setInterval(() => {
  const ping = JSON.stringify({ type:'ping', t:Date.now() });
  coachClients.forEach(c => { if (c?.readyState===1) c.send(ping); });
}, 2_000);
setInterval(() => {
  const ping = JSON.stringify({ type:'ping', t:Date.now() });
  deviceWsMap.forEach((info, ws) => { if (ws?.readyState===1) ws.send(ping); });
}, 15_000);

// Reaper sessioni stale (v0.3.0 audit #16): chiude/scarta le sessioni il cui
// ultimo frame è troppo vecchio (es. device sparito senza ws close pulito) → evita
// leak della Map e sessioni mai chiuse. sessionEnd salva se ≥20 frame, altrimenti
// scarta. Soglia oltre il keepalive device (15s) con margine.
const SESSION_STALE_MS = 90_000;
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, sess] of [...sessions]) {
    if (now - (sess.lastSeen || 0) > SESSION_STALE_MS) {
      console.log(`[reaper] sessione stale ${deviceId} (${Math.round((now-sess.lastSeen)/1000)}s) → chiusura`);
      sessionEnd(deviceId);   // salva/scarta + sessions.delete
      lastFrameByDevice.delete(deviceId);
      frameHistory.delete(deviceId);
    }
  }
}, 30_000);

httpServer.listen(PORT, '0.0.0.0', () => {
  const pending = pendingLoad();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  AeroDrag Coach Server v4 — multi-atleta`);
  console.log(`  Porta: ${PORT}  |  Sessioni in coda: ${pending.length}`);
  console.log(`  ESP32 (uplink primario): ws://${WIFI_IP}:${PORT}/device`);
  console.log(`  /coach: fallback legacy DEPRECATO (v0.3.0 — app solo-BLE)`);
  console.log(`  Dashboard coach (USB):   http://${USB_IP}:${PORT}/dashboard`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
