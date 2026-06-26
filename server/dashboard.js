const LAP_COLORS = ['#00c896','#f0a020','#3a8cf0','#8b5cf6','#f06090','#22c55e','#fb923c','#38bdf8'];
const N = 180;

// ── State ─────────────────────────────────────────────────────────────────────
const sess = { n:0, sumCdA:0, sumPwr:0, sumSpd:0, sumHr:0, sumAero:0, sumWind:0,
               pkCdA:0, btCdA:9, pkPwr:0, pkHr:0, pkAero:0, pkSpd:0, mnSpd:999,
               avSpd:0, avPwr:0, avHr:0, avAero:0, dist:0, frames:0 };

const laps  = {};   // { lapNum: { n, sumCdA, sumPwr, sumSpd, sumHr, sumAero, sumWind, sumCad, startTs, pts[] } }
const lapNotes = {};
let curLap = 1, sessStart = null;

// Chart buffers
const cBuf = Array(N).fill(null), pBuf = Array(N).fill(null);
const sBuf = Array(N).fill(null), hBuf = Array(N).fill(null);
const wBuf = Array(N).fill(null), aBuf = Array(N).fill(null);
const spk  = Array(30).fill(null);
const lapBounds = [];

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws, pingTs, reconnTimer;
document.getElementById('r-addr').textContent = location.host;

function connect() {
  ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen  = () => { setConn('connected'); clearTimeout(reconnTimer); };
  ws.onclose = () => { setConn('off'); reconnTimer = setTimeout(connect, 2000); };
  ws.onerror = () => {};
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (m.type==='ping')             { document.getElementById('r-lat').textContent=(Date.now()-pingTs||0)+'ms'; pingTs=Date.now(); }
      else if (m.type==='device_connected')   { document.getElementById('waiting').style.display='none'; document.getElementById('p-ble').textContent='BLE ✓'; document.getElementById('p-ble').className='pill pt'; }
      else if (m.type==='device_disconnected'){ document.getElementById('waiting').style.display='flex'; }
      else if (m.type==='history')     { m.frames.forEach(f=>ingest(f,false)); }
      else if (m.type==='cmd_echo')    { handleEcho(m); }
      else if (m.type==='cmd_error')   { toast('Device non connesso','#e83a50'); }
      else if (m.type==='lap_note')    { applyNote(m.lapNum, m.text); }
      else if (m.type==='athletes')    { handleAthletesMsg(m); }
      else if (m.CdA !== undefined) { document.getElementById('waiting').style.display='none';
        updateAthletePanel(m); }
    } catch{}
  };
}
connect();

function setConn(s) {
  const el = document.getElementById('p-conn');
  if (s==='connected') { el.textContent='Pi ✓'; el.className='pill pt'; }
  else { el.textContent='Disconnesso'; el.className='pill pm'; }
}

// Fix D1: focusDevice — il pannello centrale aggrega frame di UN solo atleta
// per evitare medie miste tra atleti diversi. In single-athlete è null e accetta tutto.
let focusDevice = null;

// ── Ingest frame ──────────────────────────────────────────────────────────────
function ingest(f, live) {
  if (!f.CdA) return;
  // Fix D1: con multi-atleta, ignora frame di atleti non focus per il pannello centrale.
  // I pannelli individuali (updateAthletePanel) ricevono comunque tutti i frame.
  if (focusDevice && f.device && f.device !== focusDevice) {
    updateAthletePanel(f);   // pannello individuale comunque aggiornato
    return;
  }
  // Auto-imposta focus al primo device se non già fissato
  if (!focusDevice && f.device) focusDevice = f.device;
  if (!sessStart) sessStart = f.t;
  const lap = f.lap || 1;
  if (!laps[lap]) {
    laps[lap] = { n:0, sumCdA:0, sumPwr:0, sumSpd:0, sumHr:0, sumAero:0, sumWind:0, sumCad:0, startTs:f.t, pts:[] };
    if (lap > 1) lapBounds.push(sBuf.filter(v=>v!==null).length - 1);
  }
  const lp = laps[lap];
  lp.n++; lp.sumCdA+=f.CdA; lp.sumPwr+=(f.pwr||0);
  lp.sumSpd+=(f.spd||0); lp.sumHr+=(f.hr||0);
  const paero = Math.round((f.pwr||0)*(Number.isFinite(f.pctAero) ? f.pctAero : 76)/100);
  lp.sumAero+=paero; lp.sumWind+=(f.wind||0); lp.sumCad+=(f.cad||0);
  lp.pts.push({s:(f.t-lp.startTs)/1000, CdA:f.CdA, pwr:f.pwr||0, hr:f.hr||0,
               spd:f.spd||0, wind:f.wind||0, aero:paero, cad:f.cad||0});
  curLap = lap;

  // Session
  sess.n++; sess.frames++;
  sess.sumCdA+=f.CdA; sess.sumPwr+=(f.pwr||0); sess.sumSpd+=(f.spd||0);
  sess.sumHr+=(f.hr||0); sess.sumAero+=paero; sess.sumWind+=(f.wind||0);
  if (f.CdA>sess.pkCdA) sess.pkCdA=f.CdA;
  if (f.CdA<sess.btCdA) sess.btCdA=f.CdA;
  if ((f.pwr||0)>sess.pkPwr) sess.pkPwr=f.pwr;
  if ((f.hr||0)>sess.pkHr)   sess.pkHr=f.hr;
  if (paero>sess.pkAero)      sess.pkAero=paero;
  if ((f.spd||0)>sess.pkSpd) sess.pkSpd=f.spd;
  if ((f.spd||0)>0&&(f.spd||0)<sess.mnSpd) sess.mnSpd=f.spd;
  sess.avSpd  = +(sess.sumSpd/sess.n).toFixed(1);
  sess.avPwr  = Math.round(sess.sumPwr/sess.n);
  sess.avHr   = Math.round(sess.sumHr/sess.n);
  sess.avAero = Math.round(sess.sumAero/sess.n);
  sess.dist  += (f.spd||0)/3.6*0.5;

  const push = (a,v) => { a.push(v); if (a.length>N) a.shift(); };
  push(cBuf, +(f.CdA).toFixed(4));        // CdA grezzo → asse Y reale
  push(pBuf, (f.pwr||0));                  // Watt pieni → asse Y sinistro
  push(sBuf, +(f.spd||0).toFixed(1));      // km/h → asse Y destro
  push(hBuf, +((f.hr||0)/10).toFixed(1));
  push(wBuf, +(f.wind||0).toFixed(2));
  push(aBuf, +(paero/10).toFixed(1));
  spk.push(f.CdA); if(spk.length>30) spk.shift();

  if (live) updateUI(f, paero, lap);
}

// ── Update UI ─────────────────────────────────────────────────────────────────
let uiTick = 0;
function updateUI(f, paero, lap) {
  uiTick++;
  const av = n => n>0 ? (sess.sumCdA/n).toFixed(3) : '—';

  // CdA big
  const cdaEl = document.getElementById('cda-big');
  cdaEl.textContent = f.CdA.toFixed(3);
  cdaEl.style.color = f.CdA<0.240?'#00c896':f.CdA<0.270?'#f0a020':'#e83a50';

  $('#cda-pk').textContent  = sess.pkCdA.toFixed(3);
  $('#cda-best').textContent= sess.btCdA===9?'—':sess.btCdA.toFixed(3);
  $('#cda-avg').textContent = av(sess.n);
  $('#lap-n').textContent   = lap;

  // Lap current
  const lp = laps[lap];
  $('#lc-cda').textContent = (lp.sumCdA/lp.n).toFixed(3);
  $('#lc-pwr').textContent = Math.round(lp.sumPwr/lp.n)+' W';
  $('#lc-spd').textContent = (lp.sumSpd/lp.n).toFixed(1);
  $('#lc-hr').textContent  = Math.round(lp.sumHr/lp.n)||'—';
  $('#lc-cad').textContent = Math.round(lp.sumCad/lp.n)||'—';
  const lapSec = Math.round((f.t - lp.startTs)/1000);
  $('#lc-dur').textContent = fmt(lapSec);

  // Metric strip
  $('#m-cda').textContent  = f.CdA.toFixed(3);
  $('#m-spd').textContent  = (f.spd||0).toFixed(1)+' km/h';
  $('#m-pwr').textContent  = (f.pwr||0)+' W';
  $('#m-aero').textContent = paero+' W';
  $('#m-hr').textContent   = (f.hr||0)+' bpm';
  $('#m-cad').textContent  = (f.cad||0)+' rpm';
  $('#m-wind').textContent = (f.wind||0).toFixed(1)+' m/s';
  $('#m-bat').textContent  = (f.battery||0)+'%';
  $('#m-dist').textContent = (sess.dist/1000).toFixed(1)+'km';

  $('#pk-cda').textContent = sess.pkCdA.toFixed(3);
  $('#av-cda').textContent = av(sess.n);
  $('#bt-cda').textContent = sess.btCdA===9?'—':sess.btCdA.toFixed(3);
  $('#pk-spd').textContent = sess.pkSpd.toFixed(1);
  $('#av-spd').textContent = sess.avSpd;
  $('#mn-spd').textContent = sess.mnSpd===999?'—':sess.mnSpd.toFixed(1);
  $('#pk-pwr').textContent = sess.pkPwr;
  $('#av-pwr').textContent = sess.avPwr;
  $('#pk-aero').textContent= sess.pkAero;
  $('#av-aero').textContent= sess.avAero;
  $('#pct-aero').textContent= (Number.isFinite(f.pctAero) ? f.pctAero : 76)+'%';
  $('#pk-hr').textContent  = sess.pkHr;
  $('#av-hr').textContent  = sess.avHr;

  // Right panel
  $('#r-avg-cda').textContent  = av(sess.n);
  $('#r-best-cda').textContent = sess.btCdA===9?'—':sess.btCdA.toFixed(4);
  $('#r-avg-pwr').textContent  = sess.avPwr+' W';
  $('#r-avg-hr').textContent   = sess.avHr+' bpm';
  $('#r-dist').textContent     = (sess.dist/1000).toFixed(2)+' km';
  $('#r-wind').textContent     = (sess.sumWind/sess.n).toFixed(1)+' m/s';
  $('#r-frames').textContent   = sess.frames;

  // Power breakdown
  const pctA = Number.isFinite(f.pctAero) ? f.pctAero : 76, pctR = Math.max(0, Math.round((f.pwr>0?(f.pwr-paero)/f.pwr*100:0)));
  document.getElementById('pwr-breakdown').innerHTML = [
    ['Aerodinamica', pctA, '#f5a623'],
    ['Rolling',      pctR, '#4d9fff'],
    ['Gravità/altro',Math.max(0,100-pctA-pctR), '#46587c'],
  ].map(([l,p,c])=>`
    <div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px">
        <span style="color:var(--dim)">${l}</span><span style="color:${c};font-weight:600">${p}%</span>
      </div>
      <div class="bar-bg"><div class="bar-fill" style="width:${Math.max(0,p)}%;background:${c}"></div></div>
    </div>`).join('');

  // Insights
  const ins = [];
  if (f.CdA < 0.230) ins.push(`✦ <b style="color:var(--teal)">CdA eccellente</b> — sotto 0.230.`);
  if ((f.wind||0) > 3) ins.push(`↗ Vento contrario forte <b>${(f.wind||0).toFixed(1)} m/s</b> — impatto CdA.`);
  if ((f.hr||0) > 175) ins.push(`⚠ FC elevata <b style="color:var(--red)">${f.hr} bpm</b>.`);
  const lapCdA = lp.sumCdA/lp.n;
  if (sess.n>20 && lapCdA < sess.sumCdA/sess.n - 0.005)
    ins.push(`✦ Lap ${lap} miglior CdA medio finora.`);
  if (!ins.length && sess.n>10) ins.push('✓ Parametri nella norma.');
  document.getElementById('insights').innerHTML = ins.map(i=>`<div style="margin-bottom:4px">${i}</div>`).join('');

  // REC pill
  if (sessStart) {
    document.getElementById('p-rec').style.display='flex';
    document.getElementById('rec-t').textContent=fmt(Math.round((f.t-sessStart)/1000));
  }

  // ANT/SPD indicators
  if (f.pwr>0) { $('#p-ant').textContent='ANT+ ✓'; $('#p-ant').className='pill pt'; }
  if (f.spd>0) { $('#p-spd').textContent='SPD ✓';  $('#p-spd').className='pill pt'; }

  // Charts and lap list every N frames
  // Linea "best" tratteggiata sul grafico CdA (derivata client-side)
  cdaChart.data.datasets[1].data = Array(N).fill(sess.btCdA===9 ? null : sess.btCdA);
  cdaChart.update('none');
  pvChart.update('none');
  sparkChart.update('none');
  if (uiTick % 20 === 0) updateLapList();
  if (uiTick % 50 === 0) { updateLapBars(); updateCompare(); updateOverlay(); updateTable(); }
}

// ── Charts ────────────────────────────────────────────────────────────────────
const sparkChart = new Chart($('spark'), {
  type:'line', data:{labels:Array(30).fill(''),datasets:[{data:spk,borderColor:'#00c896',
  borderWidth:1.5,pointRadius:0,fill:true,backgroundColor:'rgba(0,200,150,.07)',tension:.4}]},
  options:{responsive:true,maintainAspectRatio:false,animation:false,
           plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false}}}
});

const lapLinePlugin = {id:'ll', afterDraw(chart){
  lapBounds.forEach(idx=>{
    const x=chart.scales.x.getPixelForIndex(idx);
    const ctx=chart.ctx;
    ctx.save();ctx.beginPath();ctx.moveTo(x,chart.chartArea.top);ctx.lineTo(x,chart.chartArea.bottom);
    ctx.strokeStyle='rgba(200,200,200,.2)';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.stroke();
    ctx.fillStyle='rgba(200,200,200,.4)';ctx.font='9px monospace';
    ctx.fillText('L'+(lapBounds.indexOf(idx)+2),x+2,chart.chartArea.top+10);ctx.restore();
  });
}};

// Etichette tempo (-Ns … ora), N campioni @ 2 Hz
const timeLabels = Array.from({length:N},(_,i)=> (i%60===0)?`-${Math.round((N-1-i)/2)}s`:'');

// Grafico 1 — CdA nel tempo: asse Y reale (m²) + linea best tratteggiata + area
const cdaChart = new Chart($('mainChart'),{
  type:'line',
  data:{labels:timeLabels,datasets:[
    {label:'CdA',data:cBuf,borderColor:'#00d9a3',borderWidth:2,pointRadius:0,
     fill:true,backgroundColor:'rgba(0,217,163,.08)',tension:.35},
    {label:'Best',data:Array(N).fill(null),borderColor:'#8398bd',borderWidth:1,
     pointRadius:0,fill:false,borderDash:[5,4],tension:0},
  ]},
  options:{responsive:true,maintainAspectRatio:false,animation:false,
    plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
      backgroundColor:'rgba(15,20,32,.92)',titleColor:'#8398bd',bodyColor:'#dbe6f6',
      callbacks:{label:ctx=>ctx.raw==null?'':`${ctx.dataset.label}: ${(+ctx.raw).toFixed(4)} m²`}}},
    scales:{
      x:{display:true,ticks:{color:'#46587c',font:{size:9},maxRotation:0,autoSkip:false},
         grid:{color:'rgba(120,160,220,.05)'}},
      y:{min:0.18,max:0.34,ticks:{color:'#46587c',font:{size:9},stepSize:0.03,
         callback:v=>(+v).toFixed(2)},grid:{color:'rgba(120,160,220,.06)'},
         title:{display:true,text:'CdA (m²)',color:'#46587c',font:{size:9}}}}},
  plugins:[lapLinePlugin]
});

// Grafico 2 — Potenza & velocità: doppio asse Y (W sinistra, km/h destra)
const pvChart = new Chart($('pvChart'),{
  type:'line',
  data:{labels:timeLabels,datasets:[
    {label:'Potenza',data:pBuf,borderColor:'#f5a623',borderWidth:1.8,pointRadius:0,fill:false,tension:.3,yAxisID:'y'},
    {label:'Velocità',data:sBuf,borderColor:'#4d9fff',borderWidth:1.8,pointRadius:0,fill:false,tension:.3,yAxisID:'y1'},
  ]},
  options:{responsive:true,maintainAspectRatio:false,animation:false,
    plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
      backgroundColor:'rgba(15,20,32,.92)',titleColor:'#8398bd',bodyColor:'#dbe6f6',
      callbacks:{label:ctx=>ctx.dataset.label==='Potenza'
        ?`Potenza: ${(+ctx.raw).toFixed(0)} W`:`Velocità: ${(+ctx.raw).toFixed(1)} km/h`}}},
    scales:{
      x:{display:true,ticks:{color:'#46587c',font:{size:9},maxRotation:0,autoSkip:false},
         grid:{color:'rgba(120,160,220,.05)'}},
      y:{position:'left',beginAtZero:true,ticks:{color:'#f5a623',font:{size:9}},
         grid:{color:'rgba(120,160,220,.06)'},title:{display:true,text:'W',color:'#f5a623',font:{size:9}}},
      y1:{position:'right',beginAtZero:true,ticks:{color:'#4d9fff',font:{size:9}},
         grid:{display:false},title:{display:true,text:'km/h',color:'#4d9fff',font:{size:9}}}}},
});

// Lap bar charts
let lapBarC=null, pwrBarC=null;
function updateLapBars() {
  const ns = Object.keys(laps).map(Number).sort((a,b)=>a-b);
  const avCdA = ns.map(n=>(laps[n].sumCdA/laps[n].n).toFixed(4));
  const avPwr = ns.map(n=>Math.round(laps[n].sumPwr/laps[n].n));
  const cols  = ns.map(n=>LAP_COLORS[(n-1)%LAP_COLORS.length]);
  const barOpts = (min,max,cb) => ({responsive:true,maintainAspectRatio:false,animation:false,
    plugins:{legend:{display:false},tooltip:{callbacks:{label:cb}}},
    scales:{x:{ticks:{color:'#4a5a7a',font:{size:9}},grid:{display:false}},
            y:{min,max,ticks:{color:'#4a5a7a',font:{size:8},callback:v=>+v.toFixed(3)},
               grid:{color:'rgba(100,140,200,.05)'}}}});
  const upd = (chart, data) => { chart.data.labels=ns.map(n=>`L${n}`);
    chart.data.datasets[0].data=data; chart.data.datasets[0].backgroundColor=cols.map(c=>c+'99');
    chart.data.datasets[0].borderColor=cols; chart.update('none'); };
  if (!lapBarC) lapBarC=new Chart($('lapBarChart'),{type:'bar',
    data:{labels:ns.map(n=>`L${n}`),datasets:[{data:avCdA,backgroundColor:cols.map(c=>c+'99'),
    borderColor:cols,borderWidth:1.5,borderRadius:3}]},
    options:barOpts(.22,.30,ctx=>`CdA: ${ctx.raw}`)});
  else upd(lapBarC, avCdA);
  if (!pwrBarC) pwrBarC=new Chart($('pwrBarChart'),{type:'bar',
    data:{labels:ns.map(n=>`L${n}`),datasets:[{data:avPwr,backgroundColor:cols.map(c=>c+'99'),
    borderColor:cols,borderWidth:1.5,borderRadius:3}]},
    options:barOpts(0,0,ctx=>`${ctx.raw} W`)});
  else upd(pwrBarC, avPwr);
}

// Normalized compare charts
let cmpCdAC=null, cmpPwrC=null, cmpHrC=null;
function updateCompare() {
  const ns = Object.keys(laps).map(Number).sort((a,b)=>a-b);
  if (ns.length < 2) return;
  const minLen = Math.min(...ns.map(n=>laps[n].pts.length));
  if (minLen < 5) return;
  const labels = Array.from({length:minLen},(_,i)=>i%10===0?`${i*4}s`:'');
  const mk = (key, div=1) => ns.map(n=>({
    label:`LAP ${n}`, data:laps[n].pts.slice(0,minLen).map(p=>+(p[key]/div).toFixed(3)),
    borderColor:LAP_COLORS[(n-1)%LAP_COLORS.length], backgroundColor:LAP_COLORS[(n-1)%LAP_COLORS.length]+'18',
    borderWidth:2, pointRadius:0, fill:false, tension:.4
  }));
  const baseOpts = (min,max,cb) => ({responsive:true,maintainAspectRatio:false,animation:false,
    plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
      backgroundColor:'rgba(15,20,32,.92)',titleColor:'#7a90b8',bodyColor:'#c8d8f0',
      callbacks:{label:ctx=>cb(ctx)}}},
    scales:{x:{ticks:{color:'#4a5a7a',font:{size:8}},grid:{color:'rgba(100,140,200,.04)'}},
            y:{min,max,ticks:{color:'#4a5a7a',font:{size:8}},grid:{color:'rgba(100,140,200,.05)'}}}});
  const upd=(c,ds)=>{c.data.labels=labels;c.data.datasets=ds;c.update('none');};
  if (!cmpCdAC) cmpCdAC=new Chart($('cmpCdA'),{type:'line',data:{labels,datasets:mk('CdA')},
    options:baseOpts(.21,.32,ctx=>`LAP ${ctx.datasetIndex+1}: ${ctx.raw.toFixed(4)}`)});
  else upd(cmpCdAC, mk('CdA'));
  if (!cmpPwrC) cmpPwrC=new Chart($('cmpPwr'),{type:'line',data:{labels,datasets:mk('pwr')},
    options:baseOpts(0,0,ctx=>`LAP ${ctx.datasetIndex+1}: ${ctx.raw.toFixed(0)} W`)});
  else upd(cmpPwrC, mk('pwr'));
  if (!cmpHrC) cmpHrC=new Chart($('cmpHr'),{type:'line',data:{labels,datasets:mk('hr')},
    options:baseOpts(0,0,ctx=>`LAP ${ctx.datasetIndex+1}: ${ctx.raw.toFixed(0)} bpm`)});
  else upd(cmpHrC, mk('hr'));
  // Legends
  ['cmp-legend','cmp-leg2'].forEach(id=>{
    document.getElementById(id).innerHTML = ns.map(n=>
      `<span class="leg"><span style="background:${LAP_COLORS[(n-1)%LAP_COLORS.length]}"></span>LAP ${n}</span>`).join('');
  });
}

// Overlay charts
let ovCdaWC=null, ovAeroC=null, ovHrSC=null;
function updateOverlay() {
  const allPts = [];
  Object.keys(laps).map(Number).sort((a,b)=>a-b)
    .forEach(n=>laps[n].pts.forEach(p=>allPts.push(p)));
  if (allPts.length < 10) return;
  const step = Math.max(1,Math.floor(allPts.length/120));
  const sampled = allPts.filter((_,i)=>i%step===0);
  const labs = sampled.map((_,i)=>i%20===0?`${Math.round(i*step*4/60)}min`:'');
  const makeDS = (key,col,div=1) => ({data:sampled.map(p=>+(p[key]/(div||1)).toFixed(2)),
    borderColor:col,borderWidth:1.5,pointRadius:0,fill:false,tension:.3});
  const sopts = (min,max) => ({responsive:true,maintainAspectRatio:false,animation:false,
    plugins:{legend:{display:false}},
    scales:{x:{ticks:{color:'#4a5a7a',font:{size:8}},grid:{color:'rgba(100,140,200,.03)'}},
            y:{min,max,ticks:{color:'#4a5a7a',font:{size:8}},grid:{color:'rgba(100,140,200,.05)'}}}});
  if (!ovCdaWC) ovCdaWC=new Chart($('ovCdaWind'),{type:'line',
    data:{labels:labs,datasets:[makeDS('CdA','#00c896'),makeDS('wind','#3a8cf0')]},
    options:sopts(.20,.34)});
  else { ovCdaWC.data.labels=labs; ovCdaWC.data.datasets=[makeDS('CdA','#00c896'),makeDS('wind','#3a8cf0')]; ovCdaWC.update('none'); }
  if (!ovAeroC) ovAeroC=new Chart($('ovAero'),{type:'line',
    data:{labels:labs,datasets:[makeDS('pwr','#f0a020',10),makeDS('aero','#e83a50',10)]},
    options:sopts(0,0)});
  else { ovAeroC.data.labels=labs; ovAeroC.data.datasets=[makeDS('pwr','#f0a020',10),makeDS('aero','#e83a50',10)]; ovAeroC.update('none'); }
  if (!ovHrSC) ovHrSC=new Chart($('ovHrSpd'),{type:'line',
    data:{labels:labs,datasets:[makeDS('hr','#e83a50',5),makeDS('spd','#3a8cf0')]},
    options:sopts(0,0)});
  else { ovHrSC.data.labels=labs; ovHrSC.data.datasets=[makeDS('hr','#e83a50',5),makeDS('spd','#3a8cf0')]; ovHrSC.update('none'); }
}

// Radar
let radarC=null;
function updateRadar() {
  const ns = Object.keys(laps).map(Number).sort((a,b)=>a-b);
  if (ns.length < 1) return;
  const S = ns.map(n=>({
    CdA:  laps[n].sumCdA/laps[n].n,
    pwr:  laps[n].sumPwr/laps[n].n,
    spd:  laps[n].sumSpd/laps[n].n,
    hr:   laps[n].sumHr/laps[n].n,
    wind: laps[n].sumWind/laps[n].n,
    cad:  laps[n].sumCad/laps[n].n,
  }));
  const norm=(val,min,max,inv)=>{const r=(val-min)/(max-min||1);return Math.round((inv?1-r:r)*100);};
  const get=(k,inv)=>S.map(s=>norm(s[k],Math.min(...S.map(x=>x[k])),Math.max(...S.map(x=>x[k])),inv));
  const axes=['CdA\neffic.','Potenza','Velocità','FC ctrl','Vento','Cadenza'];
  const datasets=ns.map((n,i)=>({label:`LAP ${n}`,
    data:[get('CdA',true)[i],get('pwr',false)[i],get('spd',false)[i],
          get('hr',false)[i],get('wind',true)[i],get('cad',false)[i]],
    borderColor:LAP_COLORS[(n-1)%LAP_COLORS.length],
    backgroundColor:LAP_COLORS[(n-1)%LAP_COLORS.length]+'22',
    borderWidth:2,pointRadius:3,pointBackgroundColor:LAP_COLORS[(n-1)%LAP_COLORS.length]}));
  if (!radarC) radarC=new Chart($('radarChart'),{type:'radar',data:{labels:axes,datasets},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{r:{min:0,max:100,ticks:{display:false},grid:{color:'rgba(100,140,200,.12)'},
               angleLines:{color:'rgba(100,140,200,.12)'},pointLabels:{color:'#7a90b8',font:{size:10}}}}}});
  else { radarC.data.datasets=datasets; radarC.update(); }
  // Score list
  document.getElementById('score-list').innerHTML = ns.map((n,i)=>{
    const sc=Math.round(datasets[i].data.reduce((a,v)=>a+v,0)/6);
    const col=LAP_COLORS[(n-1)%LAP_COLORS.length];
    return `<div style="background:var(--s2);border:1px solid var(--border);border-radius:7px;
              padding:8px 10px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
        <span style="font-size:10px;color:${col};font-weight:700">LAP ${n}</span>
        <span style="font-size:20px;font-weight:700;color:${col}">${sc}</span>
      </div>
      <div class="bar-bg"><div class="bar-fill" style="width:${sc}%;background:${col}"></div></div>
      <div style="font-size:9px;color:var(--dim);margin-top:3px">Performance /100</div>
    </div>`;
  }).join('');
  document.getElementById('radar-legend').innerHTML=ns.map(n=>
    `<span class="leg"><span style="background:${LAP_COLORS[(n-1)%LAP_COLORS.length]}"></span>LAP ${n}</span>`).join('');
}

// Full comparison table
function updateTable() {
  const ns = Object.keys(laps).map(Number).sort((a,b)=>a-b);
  if (!ns.length) return;
  const S = ns.map(n=>({n, lp:laps[n],
    CdA:  +(laps[n].sumCdA/laps[n].n).toFixed(4),
    // Fix D3: reduce invece di Math.min(...arr) — safe per array grandi
    bCdA: +(laps[n].pts.reduce((m,p)=>p.CdA<m?p.CdA:m, Infinity)).toFixed(4),
    pwr:  Math.round(laps[n].sumPwr/laps[n].n),
    spd:  +(laps[n].sumSpd/laps[n].n).toFixed(1),
    hr:   Math.round(laps[n].sumHr/laps[n].n)||'—',
    cad:  Math.round(laps[n].sumCad/laps[n].n)||'—',
    wind: +(laps[n].sumWind/laps[n].n).toFixed(1),
    aero: Math.round(laps[n].sumAero/laps[n].n),
    dur:  fmt(Math.round((laps[n].pts[laps[n].pts.length-1]?.s||0))),
    note: lapNotes[n]||'',
  }));
  const rows=[
    {k:'CdA avg',   f:s=>s.CdA,  lower:true,  fmt:v=>v.toFixed(4), col:'#00c896'},
    {k:'CdA best',  f:s=>s.bCdA, lower:true,  fmt:v=>v.toFixed(4), col:'#00c896'},
    {k:'Potenza W', f:s=>s.pwr,  lower:false, fmt:v=>v+' W',       col:'#f0a020'},
    {k:'P.Aero W',  f:s=>s.aero, lower:false, fmt:v=>v+' W',       col:'#e83a50'},
    {k:'km/h avg',  f:s=>s.spd,  lower:false, fmt:v=>v+' km/h',    col:'#3a8cf0'},
    {k:'FC avg',    f:s=>typeof s.hr==='number'?s.hr:0, lower:false, fmt:(v,s)=>s.hr, col:'#e83a50'},
    {k:'Cadenza',   f:s=>typeof s.cad==='number'?s.cad:0, lower:false, fmt:(v,s)=>s.cad, col:'#8b5cf6'},
    {k:'Vento m/s', f:s=>s.wind, lower:true,  fmt:v=>v.toFixed(1), col:'#3a8cf0'},
    {k:'Durata',    f:s=>0,      lower:false, fmt:(v,s)=>s.dur,    col:'#4a5a7a'},
  ];
  const tbl = document.getElementById('full-table');
  tbl.innerHTML=`<thead><tr>
    <th>Metrica</th>
    ${S.map(s=>`<th style="color:${LAP_COLORS[(s.n-1)%LAP_COLORS.length]}">LAP ${s.n}</th>`).join('')}
  </tr></thead>`;
  const tbody=document.createElement('tbody');
  rows.forEach(row=>{
    const vals=S.map(s=>row.f(s));
    const best=row.lower?Math.min(...vals.filter(v=>v>0)):Math.max(...vals);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td style="color:var(--dim)">${row.k}</td>`+
      S.map((s,i)=>{const v=vals[i];const isBest=v===best&&v!==0;
        return `<td style="color:${row.col}" class="${isBest?'best':''}">${row.fmt(v,s)}${isBest?' ✦':''}</td>`;
      }).join('');
    tbody.appendChild(tr);
  });
  // Note row
  const noteRow=document.createElement('tr');
  noteRow.innerHTML=`<td style="color:var(--dim)">Note</td>`+
    S.map(s=>`<td><input class="note-input" style="width:100%" value="${(lapNotes[s.n]||'').replace(/"/g,'&quot;')}"
      placeholder="..." data-note-lap="${s.n}" data-note-device="${focusDevice||''}"></td>`).join('');
  tbody.appendChild(noteRow);
  tbl.appendChild(tbody);
}

// Lap list sidebar
function updateLapList() {
  const ns=Object.keys(laps).map(Number).sort((a,b)=>a-b);
  const el=document.getElementById('lap-list');
  el.innerHTML='<div class="lap-hdr"><span>#</span><span>CdA</span><span>W</span><span>hr</span></div>';
  ns.forEach(n=>{
    const lp=laps[n]; const col=LAP_COLORS[(n-1)%LAP_COLORS.length];
    const avg=(lp.sumCdA/lp.n).toFixed(3), pwr=Math.round(lp.sumPwr/lp.n), hr=Math.round(lp.sumHr/lp.n)||'—';
    const div=document.createElement('div');
    div.className='lap-item'+(n===curLap?' sel':'');
    div.style.padding='6px 8px';
    div.innerHTML=`
      <div style="display:grid;grid-template-columns:20px 1fr 36px 36px;gap:3px;font-size:11px">
        <span style="color:${col};font-weight:700">${n}${n===curLap?'▶':''}</span>
        <span style="color:${col}">${avg}</span><span>${pwr}</span><span style="color:var(--red)">${hr}</span>
      </div>
      <input class="note-input" value="${(lapNotes[n]||'').replace(/"/g,'&quot;')}"
        placeholder="Nota lap ${n}..." data-note-lap="${n}" data-note-device="${focusDevice||''}">`;
    el.appendChild(div);
  });
}

// Tab switch
function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  ['live','compare','overlay','radar','table'].forEach(t=>{
    document.getElementById('tab-'+t).style.display=t===name?'flex':'none';
  });
  if (name==='radar') updateRadar();
  if (name==='compare') updateCompare();
  if (name==='overlay') updateOverlay();
  if (name==='table') updateTable();
}

// Coach commands
function sendCmd(action) {
  if (ws?.readyState!==1) { toast('Nessuna connessione','#e83a50'); return; }
  // Fix D2: in multi-atleta, includi deviceId per non broadcastare a tutti
  // I lap del coach finiscono solo sull'atleta selezionato
  const msg = {type:'cmd', action};
  if (focusDevice) msg.deviceId = focusDevice;
  ws.send(JSON.stringify(msg));
  const c={lap:'#f0a020',start:'#00c896',stop:'#e83a50'};
  const l={lap:'LAP inviato ◎',start:'START inviato',stop:'STOP inviato'};
  toast(l[action]||action, c[action]);
  if (action==='lap') { const b=$('btn-lap'); b.style.transform='scale(1.15)'; setTimeout(()=>b.style.transform='',300); }
}
function handleEcho(m) {
  if (m.action==='lap') { lapBounds.push(sBuf.filter(v=>v!==null).length-1); toast('LAP segnato','#f0a020'); }
}

// Notes — `lapNotes` è già dichiarato sopra (sezione stats, ~riga 427): riuso
// lo stesso oggetto condiviso. Una seconda `const` qui causava
// "Identifier 'lapNotes' has already been declared" → script morto.
function saveLapNote(n, t, deviceId) {
  lapNotes[n] = t;
  // Fix: include deviceId — il Pi usa msg.deviceId per associare la nota all'atleta corretto
  const target = deviceId || Object.keys(athleteState)[0] || null;
  if (ws?.readyState === 1)
    ws.send(JSON.stringify({ type:'lap_note', lapNum:n, text:t, deviceId:target }));
  document.querySelectorAll(`[data-note-lap="${n}"]`).forEach(el => {
    if (document.activeElement !== el) el.value = t;
  });
}
function applyNote(n,t) { lapNotes[n]=t; document.querySelectorAll(`input[data-note-lap="${n}"]`).forEach(el=>{ if(document.activeElement!==el) el.value=t; }); }

// Toast
let toastTimer;
function toast(text, color='#c8d8f0') {
  const el=document.getElementById('toast');
  el.textContent=text; el.style.color=color; el.style.borderColor=color;
  el.style.background=color+'22'; el.style.opacity='1';
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.style.opacity='0',2200);
}

// Keyboard shortcuts
document.addEventListener('keydown', e=>{
  if (e.target.tagName==='INPUT') return;
  if (e.code==='Space') { e.preventDefault(); sendCmd('lap'); }
  if (e.key==='s') sendCmd('start');
  if (e.key==='x') sendCmd('stop');
});

// ── Event delegation (CSP: niente handler inline, contract v0.3.1 CO-1) ──────────
// Tutti i click/input passano da listener sul document che leggono i data-attribute,
// così sia gli elementi statici sia quelli generati via innerHTML sono coperti.
document.addEventListener('click', e => {
  const cmd = e.target.closest('[data-cmd]');
  if (cmd) { sendCmd(cmd.dataset.cmd, cmd.dataset.device || undefined); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { switchTab(tab.dataset.tab, tab); return; }
  if (e.target.closest('[data-hist-toggle]')) { toggleHistPanel(); return; }
  const sess = e.target.closest('[data-sess-toggle]');
  if (sess) { toggleSessExpand(sess.dataset.sessToggle); return; }
  const ghost = e.target.closest('[data-ghost-sess]');
  if (ghost) { toggleGhostLap(ghost.dataset.ghostSess, +ghost.dataset.ghostLap); return; }
  const act = e.target.closest('[data-action]');
  if (act) {
    if (act.dataset.action === 'sync-now') { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'sync_now' })); }
    else if (act.dataset.action === 'clear-ghosts') clearGhostLaps();
  }
});
document.addEventListener('input', e => {
  const note = e.target.closest('[data-note-lap]');
  if (note) saveLapNote(+note.dataset.noteLap, note.value, note.dataset.noteDevice || '');
});

// Helpers
const $ = id => document.getElementById(id);
const fmt = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

// Clock
setInterval(()=>{ document.getElementById('clock').textContent=new Date().toLocaleTimeString('it-IT'); },1000);

// ── Multi-atleta ──────────────────────────────────────────────────────────────
const ATHLETE_COLORS = ['#00c896','#f0a020','#3a8cf0','#8b5cf6','#f06090','#22c55e'];
const athleteState = {};   // { deviceId: { name, color, cda, pwr, spd, hr, cad, wind, lap, chart, buf } }
let athleteColorIdx = 0;

function handleAthletesMsg(msg) {
  const panel = document.getElementById('athlete-panels');

  // Rimuovi atleti non più connessi
  Object.keys(athleteState).forEach(id => {
    if (!msg.list.find(a => a.deviceId === id)) {
      delete athleteState[id];
      const el = document.getElementById('ap_' + id.replace(/:/g,''));
      if (el) el.remove();
    }
  });

  // Aggiungi nuovi atleti
  msg.list.forEach(a => {
    const safeId = a.deviceId.replace(/:/g,'');
    if (athleteState[a.deviceId]) return;   // già esiste
    const color = ATHLETE_COLORS[athleteColorIdx % ATHLETE_COLORS.length];
    athleteColorIdx++;
    athleteState[a.deviceId] = {
      name: a.athleteName, color, deviceId: a.deviceId,
      cda:'—', pwr:'—', spd:'—', hr:'—', cad:'—', lap:1,
      buf: Array(90).fill(null), chart: null,
    };
    createAthletePanel(a.deviceId, a.athleteName, color, safeId);
  });

  // Nascondi/mostra placeholder
  const noAth = panel.querySelector('.no-athletes');
  if (noAth) noAth.style.display = msg.list.length ? 'none' : 'flex';
}

function createAthletePanel(deviceId, name, color, safeId) {
  const panel = document.getElementById('athlete-panels');
  const div = document.createElement('div');
  div.className = 'athlete-panel';
  div.id = 'ap_' + safeId;
  div.innerHTML = `
    <div class="athlete-header">
      <span class="athlete-dot" style="background:${color}"></span>
      <span class="athlete-name" style="color:${color}">${name}</span>
      <span class="athlete-cda" id="ac_cda_${safeId}" style="color:${color}">—.———</span>
    </div>
    <div class="athlete-sub">
      <span>W: <b id="ac_pwr_${safeId}">—</b></span>
      <span>km/h: <b id="ac_spd_${safeId}">—</b></span>
      <span>bpm: <b id="ac_hr_${safeId}" style="color:#e83a50">—</b></span>
      <span>rpm: <b id="ac_cad_${safeId}">—</b></span>
      <span style="margin-left:auto">LAP <b id="ac_lap_${safeId}">1</b></span>
    </div>
    <div class="athlete-chart">
      <canvas id="ac_chart_${safeId}" style="width:100%;height:100%"></canvas>
    </div>
    <div style="padding:4px 8px;border-top:1px solid var(--border);display:flex;gap:6px">
      <button data-cmd="lap" data-device="${deviceId}"
        style="flex:1;padding:4px;border-radius:5px;border:1px solid rgba(240,160,32,.4);
               background:rgba(240,160,32,.1);color:#f0a020;cursor:pointer;
               font-family:inherit;font-size:10px;font-weight:600">◎ LAP</button>
      <button data-cmd="start" data-device="${deviceId}"
        style="flex:1;padding:4px;border-radius:5px;border:1px solid rgba(0,200,150,.4);
               background:rgba(0,200,150,.1);color:#00c896;cursor:pointer;
               font-family:inherit;font-size:10px">▶</button>
      <button data-cmd="stop" data-device="${deviceId}"
        style="flex:1;padding:4px;border-radius:5px;border:1px solid rgba(232,58,80,.4);
               background:rgba(232,58,80,.1);color:#e83a50;cursor:pointer;
               font-family:inherit;font-size:10px">⬛</button>
    </div>`;
  panel.appendChild(div);

  // Crea mini-chart CdA per questo atleta
  const ctx = document.getElementById('ac_chart_' + safeId);
  const state = athleteState[deviceId];
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(90).fill(''),
      datasets: [{
        data: state.buf,
        borderColor: color, borderWidth: 2,
        pointRadius: 0, fill: true,
        backgroundColor: color + '18', tension: .4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { min: 0.20, max: 0.35,
        ticks: { color: '#4a5a7a', font: { size: 8 } },
        grid: { color: 'rgba(100,140,200,.06)' } } }
    }
  });
}

function updateAthletePanel(frame) {
  const deviceId = frame.device;
  if (!deviceId) return;
  const state = athleteState[deviceId];
  if (!state) return;
  const safeId = deviceId.replace(/:/g,'');

  state.cda = frame.CdA?.toFixed(3) || '—';
  state.pwr = frame.pwr || '—';
  state.spd = frame.spd?.toFixed(1) || '—';
  state.hr  = frame.hr  || '—';
  state.cad = frame.cad || '—';
  state.lap = frame.lap || 1;

  const cdaEl = document.getElementById('ac_cda_' + safeId);
  if (cdaEl) {
    cdaEl.textContent = state.cda;
    cdaEl.style.color = frame.CdA < 0.230 ? '#00c896' : frame.CdA < 0.260 ? '#f0a020' : '#e83a50';
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ac_pwr_'+safeId, state.pwr);
  set('ac_spd_'+safeId, state.spd);
  set('ac_hr_'+safeId,  state.hr);
  set('ac_cad_'+safeId, state.cad);
  set('ac_lap_'+safeId, state.lap);

  // Update mini-chart
  state.buf.push(frame.CdA || null);
  if (state.buf.length > 90) state.buf.shift();
  if (state.chart) {
    state.chart.data.datasets[0].data = [...state.buf];
    state.chart.update('none');
  }

  // Aggiorna anche il lato sinistro e le metriche globali con l'ultimo atleta attivo
  // (comportamento standard: mostra dati dell'atleta "principale" = primo connesso)
  const firstAthlete = Object.values(athleteState)[0];
  if (firstAthlete && firstAthlete.deviceId === deviceId) {
    ingest(frame, true);
  }
}

// Patch sendCmd per supportare deviceId target
const _origSendCmd = sendCmd;
sendCmd = function(action, targetDeviceId) {
  if (ws?.readyState !== 1) { toast('Nessuna connessione al Pi', '#e83a50'); return; }
  ws.send(JSON.stringify({ type:'cmd', action, deviceId: targetDeviceId || null }));
  const c={lap:'#f0a020',start:'#00c896',stop:'#e83a50'};
  const l={lap:'LAP ◎',start:'▶ START',stop:'⬛ STOP'};
  const who = targetDeviceId ? (athleteState[targetDeviceId]?.name || targetDeviceId) : 'tutti';
  toast(`${l[action]||action} → ${who}`, c[action]);
};

// ── Storico sessioni ───────────────────────────────────────────────────────
let histOpen = false;
const ghostLaps = {};   // { 'sessId_lapN': { color, pts, meta } }
const GHOST_COLORS = ['#a0a0f0','#f0a0c0','#a0f0d0','#f0d0a0','#d0a0f0','#a0d0f0'];
let ghostColorIdx = 0;

function toggleHistPanel() {
  histOpen = !histOpen;
  document.getElementById('hist-panel').classList.toggle('open', histOpen);
  if (histOpen) loadHistSessions();
}

async function loadHistSessions() {
  const el = document.getElementById('hist-list');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px">Caricamento...</div>';
  try {
    // Prova prima il receiver locale del PC (porta 8081, salva sul disco del PC)
    // Fallback al Pi (porta 8080, salva sulla microSD)
    let sessUrl = 'http://192.168.7.2:8081/sessions';
    let useLocal = true;
    try { await fetch(sessUrl, { method:'HEAD', signal: AbortSignal.timeout(1000) }); }
    catch { sessUrl = '/api/sessions'; useLocal = false; }
    const res = await fetch(sessUrl);
    const sessions = await res.json();
    if (!sessions.length) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px">Nessuna sessione salvata</div>';
      return;
    }
    el.innerHTML = '';
    sessions.forEach(sess => {
      const div = document.createElement('div');
      div.className = 'hp-sess';
      div.id = 'sess_' + sess.id;
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center"
             data-sess-toggle="${sess.id}">
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text)">${sess.date} ${sess.time}</div>
            <div style="font-size:10px;color:var(--muted)">${sess.lapCount} lap</div>
          </div>
          <span style="font-size:10px;color:var(--muted)" id="arr_${sess.id}">▶</span>
        </div>
        <div id="laps_${sess.id}" style="display:none;margin-top:6px">
          ${sess.laps.map(lap => `
            <div class="hp-lap" id="ghost_${sess.id}_${lap.lapNum}"
                 data-ghost-sess="${sess.id}" data-ghost-lap="${lap.lapNum}">
              <span style="width:8px;height:8px;border-radius:50%;background:var(--muted);
                           display:inline-block" id="dot_${sess.id}_${lap.lapNum}"></span>
              <div style="flex:1">
                <span style="color:var(--dim)">LAP ${lap.lapNum}</span>
                <span style="color:var(--teal);margin-left:8px">${lap.avgCdA.toFixed(3)}</span>
                <span style="color:var(--amber);margin-left:6px">${lap.avgPowerW}W</span>
                <span style="font-size:9px;color:var(--muted);margin-left:6px">${fmt(lap.durationS)}</span>
              </div>
            </div>
            ${lap.notes ? `<div style="font-size:9px;color:var(--dim);padding:2px 8px 4px;
              font-style:italic">${lap.notes}</div>` : ''}
          `).join('')}
        </div>`;
      el.appendChild(div);
    });
  } catch(e) {
    el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:11px">Errore: ${e.message}</div>`;
  }
}

function toggleSessExpand(id) {
  const laps = document.getElementById('laps_' + id);
  const arr  = document.getElementById('arr_' + id);
  const exp  = laps.style.display === 'none';
  laps.style.display = exp ? 'block' : 'none';
  arr.textContent = exp ? '▼' : '▶';
  document.getElementById('sess_' + id).classList.toggle('expanded', exp);
}

async function toggleGhostLap(sessId, lapNum) {
  const key = `${sessId}_${lapNum}`;
  const dot = document.getElementById(`dot_${sessId}_${lapNum}`);
  const el  = document.getElementById(`ghost_${sessId}_${lapNum}`);

  if (ghostLaps[key]) {
    // Rimuovi
    delete ghostLaps[key];
    dot.style.background = 'var(--muted)';
    el.classList.remove('loaded');
    updateGhostOverlays();
    return;
  }

  // Carica dal server (con pts completi)
  dot.style.background = 'var(--amber)';
  try {
    const baseUrl = sessId.includes('local') ? 'http://192.168.7.2:8081/sessions' : '/api/sessions';
    const res  = await fetch(`${baseUrl.replace('/sessions','')}/${sessId.replace('local_','')}`);
    const data = await res.json();
    const lap  = data.laps.find(l => l.lapNum === lapNum);
    if (!lap || !lap.pts?.length) { dot.style.background='var(--red)'; return; }

    const color = GHOST_COLORS[ghostColorIdx % GHOST_COLORS.length];
    ghostColorIdx++;
    ghostLaps[key] = { color, pts: lap.pts, meta: lap, sessId, lapNum };
    dot.style.background = color;
    el.classList.add('loaded');
    updateGhostOverlays();
  } catch(e) {
    dot.style.background = 'var(--red)';
    toast('Errore caricamento lap', '#e83a50');
  }
}

function clearGhostLaps() {
  Object.keys(ghostLaps).forEach(k => {
    const [sessId, lapNum] = k.split('_');
    const dot = document.getElementById(`dot_${sessId}_${lapNum}`);
    const el  = document.getElementById(`ghost_${sessId}_${lapNum}`);
    if (dot) dot.style.background = 'var(--muted)';
    if (el)  el.classList.remove('loaded');
  });
  Object.keys(ghostLaps).forEach(k => delete ghostLaps[k]);
  updateGhostOverlays();
}

// Aggiunge i lap storici (ghost) come dataset tratteggiati ai grafici di confronto
function updateGhostOverlays() {
  const ghosts = Object.values(ghostLaps);
  if (!cmpCdAC) return;

  // Rimuovi dataset ghost precedenti (quelli con borderDash)
  ['cmpCdA','cmpPwr','cmpHr'].forEach(id => {
    const chart = id==='cmpCdA'?cmpCdAC:id==='cmpPwr'?cmpPwrC:cmpHrC;
    if (!chart) return;
    chart.data.datasets = chart.data.datasets.filter(d => !d._ghost);
    ghosts.forEach(g => {
      const key = {'cmpCdA':'CdA','cmpPwr':'pwr','cmpHr':'hr'}[id];
      const minLen = chart.data.labels.length;
      const data = g.pts.slice(0, minLen).map(p => +(p[key]||0).toFixed(key==='CdA'?4:1));
      chart.data.datasets.push({
        _ghost: true,
        label: `Storico L${g.lapNum}`,
        data,
        borderColor: g.color,
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false,
        tension: .4,
      });
    });
    chart.update('none');
  });

  // Aggiorna anche il grafico CdA (tab LIVE) con ghost CdA (scala reale m²)
  if (cdaChart) {
    cdaChart.data.datasets = cdaChart.data.datasets.filter(d => !d._ghost);
    ghosts.forEach(g => {
      const minLen = Math.min(g.pts.length, N);
      const padded = Array(N - minLen).fill(null).concat(g.pts.slice(0,minLen).map(p=>+(p.CdA).toFixed(4)));
      cdaChart.data.datasets.push({
        _ghost: true,
        label: `Storico L${g.lapNum}`,
        data: padded,
        borderColor: g.color,
        borderWidth: 1,
        borderDash: [5,4],
        pointRadius: 0,
        fill: false,
        tension: .4,
        yAxisID: 'y',
      });
    });
    cdaChart.update('none');
  }

  // Aggiorna legenda comparison
  const ns = Object.keys(laps).map(Number).sort((a,b)=>a-b);
  const liveLegs = ns.map(n=>
    `<span class="leg"><span style="background:${LAP_COLORS[(n-1)%LAP_COLORS.length]}"></span>LAP ${n}</span>`);
  const ghostLegs = ghosts.map(g=>
    `<span class="leg"><span style="background:${g.color};border:1px dashed ${g.color}"></span>↺L${g.lapNum}</span>`);
  ['cmp-legend','cmp-leg2'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.innerHTML=[...liveLegs,...ghostLegs].join('');
  });
}

