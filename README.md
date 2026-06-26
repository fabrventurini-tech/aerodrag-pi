# AeroDrag Pi — Guida Installazione

## Hardware necessario

| Componente | Costo | Dove |
|---|---|---|
| Raspberry Pi Zero 2W | ~€18 | raspberrypi.com, Amazon |
| MicroSD 16GB (classe 10) | ~€8 | Amazon |
| Cavo USB-A → Micro-USB | ~€4 | Amazon |
| Case plastica (opzionale) | ~€5 | Amazon |

**Totale: ~€30-35** — nessun router, nessun alimentatore, nessun hub.

---

## Schema di funzionamento

```
iPhone atleta
      ╎ Bluetooth (BLE) — il telefono NON entra nel WiFi del Pi
      ▼   e mantiene la propria rete internet
Device AeroDrag (ESP32)
      ↓ WiFi "AeroDrag" (creato dal Pi) — l'ESP32 è l'uplink primario
      ↓ ws://192.168.8.1:8080/device
Raspberry Pi Zero 2W
      ↓ USB (dati + alimentazione in un cavo solo)
PC Coach → browser / Electron app → http://192.168.7.1:8080/dashboard
```

> **Modello v0.3.0 (contract):** la telemetria live arriva dall'**ESP32** su
> `/device`. Il telefono resta **solo-BLE** verso il proprio ESP32 (così non lascia
> la rete internet). Il vecchio percorso `app → Pi /coach` è **deprecato** (fallback
> legacy, es. app in sim senza device).

Il cavo USB fa tre cose contemporaneamente:
1. Alimenta il Pi (5V dal PC)
2. Crea una scheda di rete virtuale sul PC (USB Ethernet gadget)
3. Trasmette i dati WebSocket

---

## Protocollo WebSocket

Tre path WebSocket sul server `:8080` (contract v0.3.x):

| Path | Chi | Ruolo |
|---|---|---|
| `/device` | **firmware ESP32** (uplink WiFi primario, confine B) | sorgente telemetria + riceve comandi |
| `/coach` | app `aerodrag-new` in **sim** (confine C — **DEPRECATO**, fallback legacy) | sorgente telemetria + riceve comandi |
| `/` | dashboard (browser Pi + Electron coach, confine D) | sola visualizzazione frame/eventi + invia comandi |

`/device` e `/coach` sono gestiti in modo identico (`hello` + frame, ricevono
`start`/`stop`/`lap`), ma in v0.3.0 **l'uplink atteso è `/device` dall'ESP32**;
`/coach` resta accettato solo come fallback legacy.

### Device (ESP32) → Pi (path: `/device`)

Al momento della connessione, il device invia un **hello**:
```json
{ "type": "hello", "device": "AA:BB:CC:DD:EE:FF", "athlete": "Mario Rossi" }
```

Poi invia frame dati a **2 Hz**:
```json
{
  "t": 1716892800000,
  "device": "AA:BB:CC:DD:EE:FF",
  "athlete": "Mario Rossi",
  "lap": 2,
  "CdA": 0.2451,
  "pwr": 207,
  "spd": 37.8,
  "hr": 145,
  "cad": 90,
  "wind": 1.8,
  "battery": 85,
  "pctAero": 87.0,
  "pitch": 2.3,
  "rho": 1.225,
  "lapEvent": false
}
```
> `pctAero` è una percentuale **0–100**. `pitch` [°], `rho` [kg/m³] e
> `lapEvent` (bool, marker di giro) fanno parte del contratto.
> **`device` è obbligatorio e dev'essere un MAC valido** (`AA:BB:CC:DD:EE:FF`):
> contract v0.1.2 §3 — i frame senza `device` valido sono rifiutati
> all'ingestione, così ogni sessione persistita ha sempre un `deviceId`
> (filename `session_{ts}_{deviceIdHex}.json`, §5).

### Pi → device (comandi coach)
```json
{ "type": "cmd", "action": "start" | "stop" | "lap" }
```
Il Pi invia i comandi sul `/device`. In v0.3.0 raggiungono l'**app** tramite il
**firmware** (BLE `COACH_LINK 0xaa0f`), non più sul `/coach` dell'app.

### Pi → Dashboard coach (path: `/`)
Tutti i frame vengono ritrasmessi ai client browser/Electron connessi al path `/`.

---

## Installazione — passo per passo

### Passo 1 — Scarica e scrivi Raspberry Pi OS

1. Scarica **Raspberry Pi Imager** da: https://raspberrypi.com/software
2. Inserisci la MicroSD nel computer
3. In Raspberry Pi Imager scegli:
   - Device: **Raspberry Pi Zero 2W**
   - OS: **Raspberry Pi OS Lite (64-bit)** — senza desktop
   - Storage: la tua MicroSD
4. Prima di scrivere clicca l'icona ⚙️ e configura:
   - Hostname: `aerodrag-pi`
   - Abilita SSH con password
   - Username: `pi`, Password: a scelta
   - **NON configurare WiFi** — lo configura il setup script
5. Scrivi la SD e inseriscila nel Pi

### Passo 2 — Prima connessione al Pi

1. Collega il Pi al PC con il cavo USB nel porto **USB** (non PWR)
   - Il porto PWR è quello più vicino al bordo
   - Il porto USB è quello centrale (OTG)
2. Aspetta 30-60 secondi che il Pi si avvii
3. Connettiti via SSH:
   ```
   ssh pi@raspberrypi.local
   ```

### Passo 3 — Copia i file sul Pi

Dal tuo PC:
```bash
scp -r aerodrag-pi/ pi@raspberrypi.local:/home/pi/
```

### Passo 4 — Personalizza la password WiFi

**Prima di eseguire il setup**, apri `setup/setup.sh` e cambia la riga:
```bash
WIFI_PASS="aerodrag2024"
```
con una password sicura a tua scelta.

### Passo 5 — Esegui il setup

Sul Pi (via SSH):
```bash
cd /home/pi/aerodrag-pi
sudo bash setup/setup.sh
```

Lo script configura tutto automaticamente in circa 2-3 minuti.

### Passo 6 — Riavvia

```bash
sudo reboot
```

Dopo il riavvio (attendere 30 secondi) il Pi è pronto.

---

## Utilizzo quotidiano

### All'inizio dell'allenamento

1. **Collega il Pi al PC del coach** con il cavo USB
2. Aspetta 20 secondi
3. **Sul PC**, apri il browser e vai a:
   ```
   http://192.168.7.1:8080/dashboard
   ```

4. **Accendi il device AeroDrag (ESP32)**: si collega da solo al WiFi `AeroDrag`
   del Pi e inizia a trasmettere la telemetria su `/device`.
   *(Il telefono dell'atleta resta accoppiato al device in **Bluetooth** e mantiene
   la propria rete internet: NON deve entrare nel WiFi del Pi — modello v0.3.0.)*

5. Il dashboard si aggiorna automaticamente appena il device trasmette. Il pill
   **BLE ✓** conferma la connessione del device.

> **Sim senza device:** solo per test, l'app può ancora collegarsi al fallback
> legacy `ws://192.168.8.1:8080/coach` (deprecato). In uso normale non serve.

---

## LED di stato

| LED | Significato |
|---|---|
| Spento | Pi non alimentato |
| Luce fissa | Server attivo, nessun atleta connesso |
| Lampeggio veloce | Atleta connesso — dati in arrivo |

---

## IP scheme

| Interfaccia | Pi | Dispositivi |
|---|---|---|
| USB → PC coach | 192.168.7.1 | PC: 192.168.7.2 (DHCP) |
| WiFi → device ESP32 | 192.168.8.1 | ESP32: 192.168.8.10-50 (DHCP) |

---

## Risoluzione problemi

**Il PC non riconosce il Pi via USB**
- Assicurati di usare il porto USB del Pi (centrale), non il porto PWR
- Su Windows installa il driver RNDIS
- Prova un cavo diverso (alcuni cavi USB sono solo alimentazione)

**Il dashboard non si apre**
- Verifica che il Pi sia connesso: `ping 192.168.7.1`
- Verifica il servizio: `ssh pi@192.168.7.1 "sudo systemctl status aerodrag"`

**La dashboard resta "in attesa del device"**
- Verifica che il **device AeroDrag (ESP32)** sia acceso e connesso al WiFi `AeroDrag`
  del Pi (è lui l'uplink su `/device`, non il telefono).
- Il telefono va accoppiato al device in **Bluetooth** (app `aerodrag-new`); non deve
  entrare nel WiFi del Pi.
- Diagnostica sul Pi: `sudo journalctl -u aerodrag -f` → all'accensione del device deve
  comparire `[device] connesso` / `device_connected`.

**Riavvio forzato del server**
```bash
ssh pi@192.168.7.1 "sudo systemctl restart aerodrag"
```
