@echo off
echo AeroDrag PC Receiver
echo Avvio ricezione sessioni dal Pi...
echo Le sessioni vengono salvate in: %USERPROFILE%\Documents\AeroDrag\sessions\
echo.
node "%~dp0pc-receiver.js"
pause
