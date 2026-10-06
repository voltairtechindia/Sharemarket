@echo off
rem ------------------------------------------------------------------------
rem  NIFTY Terminal - serve this folder on http://localhost:8080 and open it.
rem
rem  Needs Python 3 (the "py" launcher, or "python" on PATH). Nothing is
rem  installed and nothing leaves this machine except the page's own reads of
rem  the public market data sources. Keep this window open while you use the
rem  site; close it to stop.
rem
rem  Another port:  serve-local.bat 8090
rem ------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3 was not found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)

echo.
echo   NIFTY Terminal      http://localhost:%PORT%/index.html
echo   Profile             http://localhost:%PORT%/profile.html
echo   Data hub            http://localhost:%PORT%/data.html
echo.
echo   Keep this window open. Close it to stop the site.
echo.

rem Open the browser two seconds after the server starts, from this window.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:%PORT%/index.html"
%PY% -m http.server %PORT% --bind 127.0.0.1
echo.
echo The server stopped. If it said the address is in use, run:  serve-local.bat 8090
pause
