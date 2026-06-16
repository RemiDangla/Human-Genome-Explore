@echo off
REM ============================================================
REM  Genome Earth - local launcher (hg38 chr21)
REM  Starts the range-capable static server and opens the app.
REM ============================================================
cd /d "%~dp0"

echo.
echo   Genome Earth  -  hg38 / chr21
echo   ---------------------------------------------
echo   Server:  http://localhost:8000/
echo.

REM First run only: build data/ from the downloaded UCSC files
if not exist "data\chr21.seq" (
    echo   data\chr21.seq not found - running preprocess.py first...
    python preprocess.py
    echo.
)

REM Optional: enable the AI protein-role summaries (ℹ button in the protein panel).
REM Set your key here (or in your environment) — leave blank to disable that feature.
REM set ANTHROPIC_API_KEY=sk-ant-...
if defined ANTHROPIC_API_KEY (echo   AI summaries: ENABLED) else (echo   AI summaries: off  ^(set ANTHROPIC_API_KEY to enable^))
echo.

REM Launch the server in its own window (close that window to stop it).
REM It inherits this window's environment, including ANTHROPIC_API_KEY if set.
start "Genome Earth server" cmd /k "python server.py 8000"

REM Give it a moment to bind, then open the browser
timeout /t 2 /nobreak >nul
start "" http://localhost:8000/

echo   Server is running in a separate window.
echo   Close that window (or press Ctrl+C in it) to stop the server.
echo.
