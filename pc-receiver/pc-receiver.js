/**
 * AeroDrag PC Receiver v2
 * Riceve sessioni dal Pi automaticamente — sia in tempo reale che in ritardo.
 * Salva in: Documents/AeroDrag/sessions/  (o env AERODRAG_SESSIONS_DIR)
 */

// Imports — devono essere a livello modulo, non inline
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Fix 13: fetch() is native only in Node >= 18. Add version check and fallback.
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18) {
  console.error(`[receiver] Node.js ${process.versions.node} trovato — richiesto Node >= 18.`);
  console.error('[receiver] Aggiorna con: nvm install 18 && nvm use 18');
  process.exit(1);
}

// http.request wrapper to replace fetch for older Node compatibility
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method: 'GET', timeout: 5000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode,
        json: () => Promise.resolve(JSON.parse(body)), text: () => Promise.resolve(body) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const PORT        = 8081;
const PI_IP       = '192.168.7.1';   // IP Pi su USB ethernet
const PI_PORT     = 8080;

const SESSIONS_DIR = process.env.AERODRAG_SESSIONS_DIR
  || path.join(os.homedir(), 'Documents', 'AeroDrag', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Server HTTP (riceve dal Pi) ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Ping — risponde al probe del Pi
  if (req.url === '/ping') {
    res.writeHead(200); return res.end('pong');
  }

  // POST /receive?filename=... — riceve una sessione dal Pi
  if (req.method === 'POST' && req.url.startsWith('/receive')) {
    const filename = new URL(req.url, 'http://x').searchParams.get('filename') || '';
    // Contract §5 (v0.1.2+): solo session_{ts}_{deviceIdHex}.json — suffisso OBBLIGATORIO
    if (!/^session_\d+_[A-Fa-f0-9]+\.json$/.test(filename)) {
      res.writeHead(400); return res.end('Invalid');
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      fs.writeFile(path.join(SESSIONS_DIR, filename), body, err => {
        if (err) { res.writeHead(500); return res.end('Error'); }
        try {
          const d = JSON.parse(body);
          const date = new Date(d.ts).toLocaleString('it-IT');
          console.log(`[rx] ✓ ${filename} — ${d.laps?.length||0} lap (${date})`);
        } catch {}
        res.writeHead(200); res.end('OK');
      });
    });
    return;
  }

  // GET /sessions — lista sessioni salvate localmente
  if (req.url === '/sessions' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json')).sort().reverse().slice(0,100);
      const list = files.map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR,f),'utf8'));
          return {
            id: f.replace('.json',''), ts: d.ts,
            date: new Date(d.ts).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}),
            time: new Date(d.ts).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}),
            lapCount: d.laps?.length||0, synced: true,
            laps: (d.laps||[]).map(l=>({
              lapNum:l.lapNum, avgCdA:l.avgCdA, bestCdA:l.bestCdA,
              avgPowerW:l.avgPowerW, avgSpeedKmh:l.avgSpeedKmh,
              avgHr:l.avgHr, avgCad:l.avgCad, durationS:l.durationS, notes:l.notes,
            })),
          };
        } catch { return null; }
      }).filter(Boolean);
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify(list));
    } catch { res.writeHead(500); return res.end('[]'); }
  }

  // GET /sessions/:id — sessione completa
  const m = req.url.match(/^\/sessions\/(.+)$/);
  if (m && req.method === 'GET') {
    // Fix R1: valida pattern prima di path.join — previene path traversal
    // Contract §5 (v0.1.2+): suffisso deviceId OBBLIGATORIO (no forma anonima)
    if (!/^session_\d+_[A-Fa-f0-9]+$/.test(m[1])) {
      res.writeHead(400); return res.end('invalid id');
    }
    try {
      const data = fs.readFileSync(path.join(SESSIONS_DIR, m[1]+'.json'), 'utf8');
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(data);
    } catch { res.writeHead(404); return res.end('{}'); }
  }

  res.writeHead(404); res.end();
});

// ─── Sincronizzazione recupero: scarica sessioni mancanti dal Pi ──────────────
// Confronta le sessioni sul Pi con quelle sul PC e scarica quelle mancanti
async function pullMissingSessions() {
  try {
    // Sessioni sul PC
    const localFiles = new Set(
      fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json',''))
    );

    // Sessioni sul Pi
    const res  = await httpGet(`http://${PI_IP}:${PI_PORT}/api/sessions`);
    const list = await res.json();

    const missing = list.filter(s => !localFiles.has(s.id));
    if (!missing.length) {
      console.log('[sync] Nessuna sessione mancante sul PC');
      return;
    }
    console.log(`[sync] ${missing.length} sessioni da scaricare dal Pi...`);

    for (const sess of missing) {
      try {
        const r    = await httpGet(`http://${PI_IP}:${PI_PORT}/api/sessions/${sess.id}`);
        const json = await r.text();
        const filepath = path.join(SESSIONS_DIR, sess.id+'.json');
        fs.writeFileSync(filepath, json);
        const date = new Date(sess.ts).toLocaleString('it-IT');
        console.log(`[sync] ↓ ${sess.id}.json (${date}, ${sess.lapCount} lap)`);
        // Pausa 300ms tra un download e l'altro
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.warn(`[sync] Errore download ${sess.id}: ${e.message}`);
      }
    }
    console.log(`[sync] Sincronizzazione completata — ${missing.length} sessioni scaricate`);
  } catch (e) {
    // Il Pi non è ancora connesso — riprova tra 30s
    if (!e.message.includes('ECONNREFUSED') && !e.message.includes('fetch'))
      console.warn('[sync] Errore:', e.message);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AeroDrag PC Receiver v2');
  console.log(`  Salva in: ${SESSIONS_DIR}`);
  console.log(`  In ascolto su porta ${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Scarica subito le sessioni mancanti se il Pi è già connesso
  console.log('[sync] Controllo sessioni mancanti...');
  await pullMissingSessions();

  // Controlla ogni 5 minuti (gestisce la connessione tardiva del Pi)
  setInterval(pullMissingSessions, 5 * 60_000);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[rx] Porta ${PORT} già occupata — receiver già attivo, esco`);
    process.exit(0);   // Fix R4: termina il processo per evitare loop sync inutile
  } else {
    console.error('[rx] Errore:', err.message);
    process.exit(1);
  }
});
