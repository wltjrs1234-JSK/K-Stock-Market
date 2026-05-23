@echo off
pushd "%~dp0"

echo ========================================
echo K-Stock-Market GitHub Sync Tool
echo ========================================
echo.

:: 1. Check git status
echo [1/3] Checking changed files...
git status
echo.

:: 2. Input commit message
set MSG=
set /p MSG="Enter commit message (Press Enter for auto date/time): "

if "%MSG%"=="" (
    for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"`) do set MSG=update: %%i
)

echo.
echo [2/3] Adding and committing changes...
git add .
git commit -m "%MSG%"

echo.
echo [3/3] Uploading changes to GitHub...
git push

echo.
echo ========================================
echo Sync Completed successfully!
echo ========================================
echo.

popd
pause
