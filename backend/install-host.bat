@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   UNV Downloader Local Backend Host Installer
echo ===================================================
echo.

:: Get current directory path with escaped backslashes for JSON
set "CURR_DIR=%~dp0"
set "CURR_DIR=!CURR_DIR:\=\\!"

:: Generate com.unvdownloader.backend.json with absolute path for "path"
:: Allowed origins is set to our fixed extension ID: hpefpmdhljhjkblbcfmgidnoibdkjnlh
(
echo {
echo   "name": "com.unvdownloader.backend",
echo   "description": "UNV Downloader Local Backend Host",
echo   "path": "!CURR_DIR!run-backend.bat",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://hpefpmdhljhjkblbcfmgidnoibdkjnlh/"
echo   ]
echo }
) > "%~dp0com.unvdownloader.backend.json"

:: Write registry key to HKCU so it doesn't require admin privileges
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.unvdownloader.backend" /ve /d "%~dp0com.unvdownloader.backend.json" /f

echo.
echo ===================================================
echo   Native Messaging Host registered successfully!
echo   Fixed Extension ID: hpefpmdhljhjkblbcfmgidnoibdkjnlh
echo.
echo   NOTE: Please remove the old version of the
echo   extension from chrome://extensions and reload
echo   this folder as an unpacked extension again to
echo   activate the new fixed ID!
echo ===================================================
echo.
pause
