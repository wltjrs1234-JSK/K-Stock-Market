@echo off
pushd "%~dp0"

echo ========================================
echo K-Stock-Market Server Starting...
echo ========================================

:: Kill existing python processes to avoid port conflict
taskkill /F /IM python.exe >nul 2>&1
timeout /t 1 /nobreak >nul

:: Check virtual environment
if exist "venv\Scripts\activate.bat" (
    echo [1/3] Activating virtual environment...
    call venv\Scripts\activate.bat
) else (
    echo [1/3] Warning: venv not found. Using system Python...
)

:: Install dependencies
echo [2/3] Checking dependencies...
python -m pip install -r requirements.txt -q

:: Find Google Chrome path (Avoid using parenthesis in IF blocks)
set CHROME_PATH=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"

:: Launch Chrome or default browser after 3 seconds delay using PowerShell to avoid cmd quote issues
echo [3/3] Launching Chrome in 3 seconds...
if defined CHROME_PATH (
    start /B powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%CHROME_PATH%' -ArgumentList 'http://127.0.0.1:8080'"
) else (
    start /B powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8080'"
)

:: Run uvicorn server in foreground
echo Server running at http://127.0.0.1:8080
python -m uvicorn main:app --host 127.0.0.1 --port 8080 --reload

popd
pause
