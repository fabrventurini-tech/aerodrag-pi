# Schermate riviste — DASHBOARD COACH

**Mockup di riferimento:** `Dashboard coerente.dc.html`
**Repo di destinazione (CORRETTO):** **`aerodrag-pi`** → file servito `aerodrag-pi/server/dashboard.html` (il Pi la espone su `/dashboard`).

> ⚠️ **CORREZIONE REPO TARGET.** La dashboard **NON** è in `aerodrag-coach`. L'app Electron coach carica la dashboard **da remoto** e in locale ha solo `loading.html` / `settings.html`.
> → **PARTE A (HTML/CSS/JS)** e **PARTE B (dati)** vanno **ENTRAMBE su `aerodrag-pi`**.
> → `aerodrag-coach` al massimo **ritinta i suoi 2 HTML locali** (`loading.html`, `settings.html`) con la palette (vedi PARTE C).
>
> ⚠️ **Contratto dati INVARIATO (v0.2.3)**: nessun nuovo campo sul wire. Tutto ciò che serve si **deriva client-side** dai frame esistenti.

---

## 1. Design tokens — palette unificata (fonte di verità unica)

```css
:root {
  --accent:#00d9a3; --power:#f5a623; --speed:#4d9fff; --alert:#ff4d6a;
  --positive:#22c55e; --text:#dbe6f6; --text-dim:#8398bd; --muted:#46587c;
  --surface:#0f1420; --track:#1e2840; --bg:#07090f;
  --border:rgba(120,160,220,0.12); --radius-card:14px;
}
/* Numeri: JetBrains Mono tabellare. UI: Inter. Rosso (--alert) solo FC/peak/alert. */
```

---

# ═══════════════════════════════════════
# PARTE A — PRESENTAZIONE (`aerodrag-pi/server/dashboard.html`)
# ═══════════════════════════════════════

## A.1 Layout
Schermo adattato al display Pi, 3 zone: **Topbar** (wordmark, atleta, pill connessione, REC, START/LAP/STOP, orologio) · **KPI strip** 6 celle (CdA · Pot · Vel · FC · Cad · ρ) · **Body 3 colonne** (sx gauge+breakdown / centro grafici / dx lap+sessione+insight).

## A.2 Sinistra
RingGauge CdA (gradiente `accent→speed`, centro mono 38px + delta `positive`); chip Best (`accent`)/Avg (`text-dim`)/Peak (`alert`); breakdown potenza Aero (`power`)/Rolling (`speed`)/Gravità (`muted`).

## A.3 Centro — FIX GRAFICI (problema principale)
Oggi 4 serie su **un solo SVG con scale Y diverse** → illeggibile.
- **Grafico 1 — CdA nel tempo** (primario): asse Y proprio con etichette (`0.26/0.23/0.20`), linea best tratteggiata, area leggera, asse X (`-60s … ora`).
- **Grafico 2 — Potenza & velocità** (secondario): due serie con legenda, riquadro separato.

## A.4 Destra
Barre CdA per lap (best `accent`); riepilogo sessione; insight coach (card gradiente `accent`, risparmio @45 km/h).

## A.5 FIX colore (rosso sovraccarico)
CdA → `accent` ovunque; quota aero/potenza → `power`; **rosso solo** FC/peak/alert. Cella "Vento · 🔋": separare vento/batteria/distanza; **🔋 → glifo vettoriale**.

## A.6 `crrSource` — opzionale
`crrSource` **non è sul wire** → il badge "Crr · misurato" va reso **condizionale**: mostrarlo **solo se il campo esiste** nel frame, altrimenti **ometterlo** per ora. Niente badge hard-coded.

---

# ═══════════════════════════════════════
# PARTE B — DATI (sempre `aerodrag-pi`) — CONTRATTO INVARIATO
# ═══════════════════════════════════════

## B.1 Niente nuovi campi sul wire
Usare **solo** i campi già presenti nel frame:
`CdA, pwr, spd, hr, cad, wind, battery, pctAero (già c'è), pitch, rho, lap, lapEvent, device, athlete`.

## B.2 Derivazioni CLIENT-SIDE (non sul wire)
- `cda.{live,avg,best,peak}` → calcolati lato client accumulando lo stream di `CdA`.
- `series` (buffer ~60s per i grafici) → bufferizzato client-side dai frame.
- `laps[]` (CdA/W/km/h/FC per lap) → costruito client-side reagendo a `lap`/`lapEvent`.
- **Pill connessione (BLE/Pi)** → derivate dagli eventi **`device_connected`/`device_disconnected`**, **NON** da un nuovo campo `conn`.

## B.3 Cosa NON fare
- Non aggiungere `conn`, `crrSource`, `series`, `laps` al payload del Pi.
- Non cambiare la frequenza/forma dei frame esistenti.

---

# ═══════════════════════════════════════
# PARTE C — `aerodrag-coach` (solo ritintura locale)
# ═══════════════════════════════════════
Applicare la palette ai **soli** `loading.html` e `settings.html` locali dell'app Electron. Nessuna logica, nessun dato, nessuna dashboard qui.

---

## D. NOTE ANTI-REGRESSIONE (la dashboard Pi ha appena ricevuto i fix dell'issue #10)
Il restyle è **presentazione-only**. **PRESERVARE intatti:**
- una sola **`const lapNotes`** (non duplicarla/ridichiararla);
- il **router `onmessage`** che gestisce `athletes` e gli altri eventi;
- l'helper **`$`** (query selector) esistente.
- **Non toccare** l'ingestione dati / la logica WebSocket: solo markup, CSS e rendering.

## E. CHECKLIST DI ACCETTAZIONE
- [ ] Modifiche dashboard **solo** in `aerodrag-pi/server/dashboard.html` (PARTE A+B); `aerodrag-coach` solo ritintura dei 2 HTML locali (PARTE C).
- [ ] **Contratto invariato**: nessun nuovo campo sul wire; `cda.*`/`series`/`laps[]` derivati client-side.
- [ ] Pill connessione da `device_connected/disconnected` (non da `conn`).
- [ ] Badge `crrSource` **condizionale** (o omesso).
- [ ] Grafici **separati** con assi Y e unità; nessuna emoji (🔋 → SVG).
- [ ] Numeri in mono tabellare; rosso solo FC/peak/alert.
- [ ] **Nessun errore in console**; `lapNotes` singola, router `onmessage` e helper `$` intatti.
- [ ] Il **flusso dati continua a funzionare** (presentazione-only, nessuna regressione issue #10).
