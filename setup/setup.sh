#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# AeroDrag Pi Setup — Raspberry Pi Zero 2W
# ─────────────────────────────────────────────────────────────────────────────
# Configura il Pi come:
#   • USB Ethernet gadget (cavo USB → PC coach)
#   • WiFi hotspot (per l'app iPhone dell'atleta)
#   • Server Node.js con avvio automatico al boot
#
# Eseguire UNA SOLA VOLTA come root:
#   sudo bash setup.sh
#
# Schema IP:
#   USB (→ PC coach):   Pi = 192.168.7.1   PC = 192.168.7.2 (DHCP)
#   WiFi (→ iPhone):    Pi = 192.168.8.1   iPhone = 192.168.8.x (DHCP)
# ─────────────────────────────────────────────────────────────────────────────

set -e
AERODRAG_DIR="/home/pi/aerodrag"
WIFI_SSID="AeroDrag"
WIFI_PASS="aerodrag2024"
USB_IP="192.168.7.1"
WIFI_IP="192.168.8.1"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AeroDrag Pi Setup v1.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Aggiorna sistema ───────────────────────────────────────────────────────
echo "[1/8] Aggiornamento sistema..."
apt-get update -qq
apt-get install -y -qq nodejs npm hostapd dnsmasq git

# ── 2. USB Ethernet gadget (g_ether) ─────────────────────────────────────────
# Il Pi si presenta al PC come adattatore di rete USB (RNDIS/CDC Ethernet)
echo "[2/8] Configurazione USB Ethernet gadget..."

# Abilita dwc2 overlay in /boot/config.txt
if ! grep -q "dtoverlay=dwc2" /boot/config.txt; then
    echo "dtoverlay=dwc2" >> /boot/config.txt
fi

# Carica il modulo g_ether al boot
if ! grep -q "g_ether" /etc/modules; then
    echo "g_ether" >> /etc/modules
fi

# Aggiungi dwc2 a cmdline.txt (prima di rootwait)
if ! grep -q "modules-load=dwc2" /boot/cmdline.txt; then
    sed -i 's/rootwait/rootwait modules-load=dwc2,g_ether/' /boot/cmdline.txt
fi

# Configurazione IP statico per usb0 (interfaccia gadget)
cat > /etc/network/interfaces.d/usb0 << EOF
auto usb0
allow-hotplug usb0
iface usb0 inet static
    address ${USB_IP}
    netmask 255.255.255.0
EOF

# ── 3. DHCP su USB (per il PC coach) ─────────────────────────────────────────
echo "[3/8] Configurazione DHCP USB..."
cat >> /etc/dnsmasq.conf << EOF

# AeroDrag USB DHCP (per PC coach)
interface=usb0
dhcp-range=usb0,192.168.7.2,192.168.7.10,255.255.255.0,12h
EOF

# ── 4. WiFi Hotspot per iPhone atleta ────────────────────────────────────────
echo "[4/8] Configurazione WiFi hotspot '${WIFI_SSID}'..."

cat > /etc/hostapd/hostapd.conf << EOF
interface=wlan0
driver=nl80211
ssid=${WIFI_SSID}
hw_mode=g
channel=6
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=${WIFI_PASS}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
EOF

# Punta hostapd al config
sed -i 's|#DAEMON_CONF=""|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# IP statico per wlan0
cat > /etc/network/interfaces.d/wlan0 << EOF
auto wlan0
iface wlan0 inet static
    address ${WIFI_IP}
    netmask 255.255.255.0
EOF

# DHCP su wlan0 per iPhone
cat >> /etc/dnsmasq.conf << EOF

# AeroDrag WiFi DHCP (per iPhone atleta)
interface=wlan0
dhcp-range=wlan0,192.168.8.10,192.168.8.50,255.255.255.0,12h
EOF

systemctl unmask hostapd
systemctl enable hostapd

# ── 5. Installa server Node.js ────────────────────────────────────────────────
echo "[5/8] Installazione server AeroDrag..."
mkdir -p ${AERODRAG_DIR}
cp /boot/aerodrag-server.js ${AERODRAG_DIR}/server.js 2>/dev/null || \
    cp $(dirname "$0")/../server/server.js ${AERODRAG_DIR}/server.js
cp $(dirname "$0")/../server/dashboard.html ${AERODRAG_DIR}/dashboard.html
cp $(dirname "$0")/../server/package.json ${AERODRAG_DIR}/package.json

cd ${AERODRAG_DIR}
npm install --silent

# ── 6. Systemd service per avvio automatico ──────────────────────────────────
echo "[6/8] Configurazione avvio automatico..."
cat > /etc/systemd/system/aerodrag.service << EOF
[Unit]
Description=AeroDrag Coach Server
After=network.target hostapd.service
Wants=hostapd.service

[Service]
Type=simple
User=pi
WorkingDirectory=${AERODRAG_DIR}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
Environment=PORT=8080
Environment=USB_IP=${USB_IP}
Environment=WIFI_IP=${WIFI_IP}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aerodrag

# ── 7. LED status script (verde = pronto, lampeggio = atleta connesso) ────────
echo "[7/8] Configurazione LED status..."
cat > /usr/local/bin/aerodrag-led.sh << 'LEDEOF'
#!/bin/bash
# GPIO 47 = LED verde on-board Pi Zero 2W (act LED)
LED=/sys/class/leds/ACT/brightness
while true; do
    # Controlla se il server risponde
    if curl -sf http://localhost:8080/status > /tmp/aerodrag-status.json 2>/dev/null; then
        STATUS=$(python3 -c "import json,sys; d=json.load(open('/tmp/aerodrag-status.json')); print('connected' if d.get('athletes',[]) else 'off')")
        if [ "$STATUS" = "connected" ]; then
            # Atleta connesso: lampeggio veloce
            echo 1 > $LED; sleep 0.2; echo 0 > $LED; sleep 0.2
        else
            # Server attivo, nessun atleta: luce fissa
            echo 1 > $LED; sleep 1
        fi
    else
        # Server non attivo: spento
        echo 0 > $LED; sleep 1
    fi
done
LEDEOF
chmod +x /usr/local/bin/aerodrag-led.sh

cat > /etc/systemd/system/aerodrag-led.service << EOF
[Unit]
Description=AeroDrag LED Status
After=aerodrag.service

[Service]
ExecStart=/usr/local/bin/aerodrag-led.sh
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable aerodrag-led

# ── 8. Hostname e info ────────────────────────────────────────────────────────
echo "[8/8] Configurazione hostname..."
hostnamectl set-hostname aerodrag-pi
echo "127.0.1.1 aerodrag-pi" >> /etc/hosts

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup completato! Riavvia il Pi con: sudo reboot"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  WiFi hotspot (iPhone atleta):"
echo "    SSID: ${WIFI_SSID}"
echo "    Pass: ${WIFI_PASS}"
echo ""
echo "  Dashboard coach (browser PC):"
echo "    http://${USB_IP}:8080/dashboard"
echo ""
echo "  Nell'app AeroDrag — Settings:"
echo "    Modalità: Router 4G"
echo "    IP: ${WIFI_IP}"
echo "    Porta: 8080"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
