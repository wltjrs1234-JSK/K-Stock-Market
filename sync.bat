@echo off
chcp 65001 > nul
title GitHub 동기화 중...

echo.
echo  ========================================
echo    K-Stock-Market GitHub 동기화
echo  ========================================
echo.

:: 현재 폴더로 이동
cd /d "%~dp0"

:: 변경된 파일 확인
echo  [1/3] 변경된 파일 확인 중...
git status
echo.

:: 커밋 메시지 입력
set /p MSG="  커밋 메시지 입력 (Enter = 날짜/시간 자동): "

if "%MSG%"=="" (
    for /f "tokens=1-6 delims=/:. " %%a in ("%date% %time%") do (
        set MSG=update: %%a-%%b-%%c %%d:%%e
    )
)

echo.
echo  [2/3] 변경사항 저장 중...
git add .
git commit -m "%MSG%"

echo.
echo  [3/3] GitHub에 업로드 중...
git push

echo.
echo  ========================================
echo    동기화 완료!
echo  ========================================
echo.

pause
