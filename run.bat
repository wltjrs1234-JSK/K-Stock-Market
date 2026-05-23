@echo off
chcp 65001 > nul
title K-Stock-Market 실행 중...

echo.
echo  ========================================
echo    K-Stock-Market 주식 대시보드 시작
echo  ========================================
echo.

:: 현재 폴더로 이동
cd /d "%~dp0"

:: 가상환경 존재 여부 확인 후 활성화
if exist "venv\Scripts\activate.bat" (
    echo  [1/2] 가상환경 활성화 중...
    call venv\Scripts\activate.bat
) else (
    echo  [!] 가상환경 없음 - 시스템 Python 사용
)

echo  [2/2] 서버 시작 중...
echo.
echo  브라우저 주소: http://127.0.0.1:8080
echo.
echo  종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요.
echo.

:: 1초 후 브라우저 자동 열기
start /b cmd /c "timeout /t 2 > nul && start chrome http://127.0.0.1:8080"

:: 서버 실행
python -m uvicorn main:app --host 127.0.0.1 --port 8080

pause
