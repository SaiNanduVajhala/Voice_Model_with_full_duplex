@echo off
echo ==============================================
echo Starting Multi-Model Voice Assistant
echo ==============================================
echo.

echo Starting Backend Server (Wait for "Application startup complete")...
start cmd /k "cd backend && python -m uvicorn main:app --reload"

echo Starting Frontend Server...
start cmd /k "cd frontend && python -m http.server 8080"

echo.
echo Servers have been started in separate windows!
echo Make sure you have your API keys in backend/.env
echo.
echo Opening browser...
start http://localhost:8080/
pause
