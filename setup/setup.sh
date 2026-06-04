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

# Raspberry Pi OS Bookworm sposta i file di boot in /boot/firmware/
# Bullseye e precedenti usano /boot/ direttamente.
if [ -d /boot/firmware ]; then
    BOOT_DIR="/boot/firmware"
else
    BOOT_DIR="/boot"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AeroDrag Pi Setup v1.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Aggiorna sistema ───────────────────────────────────────────────────────
echo "[1/8] Aggiornamento sistema..."
apt-get update -qq
apt-get install -y -qq nodejs npm hostapd dnsmasq git

# ── 2. USB Ethernet gadget (RNDIS plug-and-play) ─────────────────────────────
# Usa configfs + Microsoft OS Descriptors → Windows installa il driver RNDIS
# automaticamente senza intervento dell'utente (plug-and-play).
echo "[2/8] Configurazione USB Ethernet gadget (plug-and-play)..."

# Abilita dwc2 in modalità peripheral nel config.txt
# Rimuove eventuali righe dwc2 precedenti e aggiunge quella corretta
sed -i '/dtoverlay=dwc2/d' "${BOOT_DIR}/config.txt"
# Inserisce dtoverlay=dwc2,dr_mode=peripheral nella sezione [all]
# (o in fondo al file se [all] non c'è)
if grep -q "^\[all\]" "${BOOT_DIR}/config.txt"; then
    sed -i '/^\[all\]/a dtoverlay=dwc2,dr_mode=peripheral' "${BOOT_DIR}/config.txt"
else
    echo "dtoverlay=dwc2,dr_mode=peripheral" >> "${BOOT_DIR}/config.txt"
fi
# Disabilita otg_mode=1 (presente nel template Bookworm per CM4, blocca il gadget)
sed -i 's/^otg_mode=1/#otg_mode=1/' "${BOOT_DIR}/config.txt"

# Rimuove modules-load dal cmdline (non funziona su tutti i kernel RPi)
sed -i 's/ modules-load=dwc2,g_ether//' "${BOOT_DIR}/cmdline.txt"
# Rimuove eventuale artefatto ds=nocloud lasciato dall'Imager
sed -i 's/ ds=nocloud;i=rpi-imager-[^ ]*//' "${BOOT_DIR}/cmdline.txt"

# Carica dwc2 e libcomposite al boot tramite modules-load.d (metodo corretto)
cat > /etc/modules-load.d/aerodrag-usb.conf << 'EOF'
dwc2
libcomposite
EOF

# Script gadget USB con Microsoft OS Descriptors per plug-and-play su Windows
cat > /usr/local/bin/aerodrag-usb-gadget.sh << GADGET_EOF
#!/bin/bash
# Crea gadget USB RNDIS con Microsoft OS Descriptors
# Windows riconosce automaticamente il dispositivo senza driver aggiuntivi.

GADGET_DIR=/sys/kernel/config/usb_gadget/aerodrag

# Attendi che configfs sia disponibile
for i in \$(seq 1 10); do
    [ -d /sys/kernel/config/usb_gadget ] && break
    sleep 1
done
[ -d /sys/kernel/config/usb_gadget ] || { echo "configfs non disponibile"; exit 1; }

# Rimuovi gadget precedente se esiste
if [ -d "\$GADGET_DIR" ]; then
    echo "" > "\$GADGET_DIR/UDC" 2>/dev/null || true
    rm -f "\$GADGET_DIR/configs/c.1/rndis.usb0" 2>/dev/null || true
    rmdir "\$GADGET_DIR/configs/c.1/strings/0x409" 2>/dev/null || true
    rmdir "\$GADGET_DIR/configs/c.1" 2>/dev/null || true
    rmdir "\$GADGET_DIR/functions/rndis.usb0" 2>/dev/null || true
    rmdir "\$GADGET_DIR/strings/0x409" 2>/dev/null || true
    rmdir "\$GADGET_DIR" 2>/dev/null || true
fi

mkdir -p "\$GADGET_DIR"
cd "\$GADGET_DIR"

# VID/PID compatibili RNDIS (Linux Foundation)
echo 0x1d6b > idVendor
echo 0x0104 > idProduct
echo 0x0200 > bcdDevice
echo 0x0200 > bcdUSB

# Microsoft OS Descriptors — dicono a Windows di usare il driver RNDIS built-in
# senza richiedere installazione manuale del driver
echo 1          > os_desc/use
echo 0xcd       > os_desc/b_vendor_code
echo "MSFT100"  > os_desc/qw_sign

mkdir -p strings/0x409
echo "AeroDrag"    > strings/0x409/manufacturer
echo "AeroDrag Pi" > strings/0x409/product
echo "aerodrag01"  > strings/0x409/serialnumber

mkdir -p configs/c.1/strings/0x409
echo "RNDIS"  > configs/c.1/strings/0x409/configuration
echo 250       > configs/c.1/MaxPower
echo 0x80      > configs/c.1/bmAttributes

mkdir -p functions/rndis.usb0
# OS descriptor per RNDIS: Windows usa questo per auto-installare il driver
echo "RNDIS"   > functions/rndis.usb0/os_desc/interface.rndis/compatible_id
echo "5162001" > functions/rndis.usb0/os_desc/interface.rndis/sub_compatible_id

ln -sf "\$GADGET_DIR/functions/rndis.usb0" "\$GADGET_DIR/configs/c.1/"
ln -sf "\$GADGET_DIR/configs/c.1" "\$GADGET_DIR/os_desc/"

# Attendi UDC
UDC=\$(ls /sys/class/udc/ 2>/dev/null | head -1)
for i in \$(seq 1 10); do
    [ -n "\$UDC" ] && break
    sleep 1
    UDC=\$(ls /sys/class/udc/ 2>/dev/null | head -1)
done
[ -z "\$UDC" ] && { echo "UDC non trovato"; exit 1; }

echo "\$UDC" > UDC
echo "Gadget USB RNDIS attivo su \$UDC"
GADGET_EOF
chmod +x /usr/local/bin/aerodrag-usb-gadget.sh

# Servizio systemd per il gadget USB (parte prima del network)
cat > /etc/systemd/system/aerodrag-usb-gadget.service << EOF
[Unit]
Description=AeroDrag USB RNDIS Gadget
After=sys-kernel-config.mount
Before=network-pre.target
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/aerodrag-usb-gadget.sh

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable aerodrag-usb-gadget

# IP statico su usb0 tramite systemd-networkd (più affidabile di interfaces.d)
mkdir -p /etc/systemd/network
cat > /etc/systemd/network/usb0.network << EOF
[Match]
Name=usb0

[Network]
Address=${USB_IP}/24
EOF
systemctl enable systemd-networkd

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
wpa_pairwise=CCMP
rsn_pairwise=CCMP
EOF

# Punta hostapd al config
sed -i 's|#DAEMON_CONF=""|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# IP statico per wlan0
mkdir -p /etc/network/interfaces.d
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
