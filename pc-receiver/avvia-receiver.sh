#!/bin/bash
echo "AeroDrag PC Receiver"
echo "Avvio ricezione sessioni dal Pi..."
echo "Le sessioni vengono salvate in: ~/Documents/AeroDrag/sessions/"
echo ""
node "$(dirname "$0")/pc-receiver.js"
