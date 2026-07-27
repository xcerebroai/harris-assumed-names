@echo off
REM Wrapper for the "HarrisAssumedNames-Daily" Windows Scheduled Task.
REM Runs the daily orchestrator (scrape -> enrich --limit 200 -> rebuild+commit+push)
REM from the repo root, appending all output to a dated log.
REM Fires 3x/day (04:00, 12:00, 20:00) with 8h gaps so each batch hits a recovered server.
setlocal
set REPO=C:\Users\Owner\projects\harris-assumed-names
cd /d "%REPO%"
if not exist logs mkdir logs
REM Locale-independent date stamp. Parsing %date% depends on the user's short-date
REM format, which produced names like daily-27Mon07.log that don't sort by date.
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set DSTAMP=%%d
echo ==== run-daily start %date% %time% ==== >> "logs\daily-%DSTAMP%.log"
"C:\Program Files\nodejs\node.exe" daily.mjs --limit 200 >> "logs\daily-%DSTAMP%.log" 2>&1
echo ==== run-daily end   %date% %time% (exit %ERRORLEVEL%) ==== >> "logs\daily-%DSTAMP%.log"
endlocal
