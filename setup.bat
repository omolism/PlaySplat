@echo off
setlocal EnableDelayedExpansion

REM =====================================================================
REM  SplatGarden Studio — one-shot Windows setup
REM  ---------------------------------------------------------------------
REM  Installs Node.js (LTS) + Git via winget if missing, then runs
REM  `npm install` in the project directory and offers to launch the
REM  Vite dev server.
REM
REM  Requirements:
REM   - Windows 10 1809+ or Windows 11 (winget is preinstalled)
REM   - Internet connection on first run
REM =====================================================================

echo.
echo ============================================================
echo   SplatGarden Studio  -  Windows Setup
echo ============================================================
echo.

REM Hop to the script's own directory so npm install hits the right repo
cd /d "%~dp0"
echo Working directory: %CD%
echo.

REM ---------------------------------------------------------------------
REM  Sanity check - winget must exist (Windows 10 1809+ / 11)
REM ---------------------------------------------------------------------
where winget >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] winget is not available on this machine.
  echo         Install "App Installer" from the Microsoft Store, or install
  echo         Node.js manually from https://nodejs.org/  and Git from
  echo         https://git-scm.com/  then re-run this script.
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------------
REM  [1/3]  Node.js LTS  (Vite needs >= 18)
REM ---------------------------------------------------------------------
echo [1/3] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo   Node.js not found - installing Node.js LTS via winget...
  winget install -e --id OpenJS.NodeJS.LTS ^
        --accept-source-agreements --accept-package-agreements ^
        --silent
  if !errorlevel! neq 0 (
    echo [ERROR] winget failed to install Node.js. Install manually:
    echo         https://nodejs.org/  -  then re-run this script.
    pause
    exit /b 1
  )
  echo   Node.js installed. Adding it to this session's PATH...
  REM winget writes PATH at machine level, but the current cmd session
  REM inherited the old value at startup. Inject the canonical install
  REM dir so `npm install` below works WITHOUT closing the window.
  if exist "C:\Program Files\nodejs\npm.cmd" (
    set "PATH=!PATH!;C:\Program Files\nodejs"
  )
  where node >nul 2>nul
  if !errorlevel! neq 0 (
    echo [ERROR] Node installed but still not reachable from this shell.
    echo         Close this window and re-run setup.bat from a fresh
    echo         Command Prompt to pick up the PATH update.
    pause
    exit /b 1
  )
  for /f "tokens=*" %%v in ('node --version') do echo   Node now active: %%v
) else (
  for /f "tokens=*" %%v in ('node --version') do echo   Found Node %%v
)
echo.

REM ---------------------------------------------------------------------
REM  [2/3]  Git  (optional but useful for cloning / pulling updates)
REM ---------------------------------------------------------------------
echo [2/3] Checking Git...
where git >nul 2>nul
if %errorlevel% neq 0 (
  echo   Git not found - installing via winget...
  winget install -e --id Git.Git ^
        --accept-source-agreements --accept-package-agreements ^
        --silent
  if !errorlevel! neq 0 (
    echo   [WARN] winget could not install Git. You can still build the
    echo          project, but `git pull` / `git push` won't work until
    echo          Git is installed manually from https://git-scm.com/
  ) else (
    REM Same PATH-refresh trick as Node — make the freshly-installed
    REM git reachable in this session without restarting cmd.
    if exist "C:\Program Files\Git\cmd\git.exe" (
      set "PATH=!PATH!;C:\Program Files\Git\cmd"
    )
    where git >nul 2>nul
    if !errorlevel! equ 0 (
      for /f "tokens=*" %%v in ('git --version') do echo   Git now active: %%v
    )
  )
) else (
  for /f "tokens=*" %%v in ('git --version') do echo   Found %%v
)
echo.

REM ---------------------------------------------------------------------
REM  [3/3]  Project dependencies  (npm install)
REM ---------------------------------------------------------------------
echo [3/3] Installing project dependencies (this takes ~30s the first time)...
if not exist package.json (
  echo [ERROR] package.json not found in %CD%
  echo         Did you place setup.bat inside the project root?
  pause
  exit /b 1
)
call npm install
if %errorlevel% neq 0 (
  echo [ERROR] npm install failed. Scroll up for the underlying error.
  pause
  exit /b 1
)
echo.

echo ============================================================
echo   Setup complete!
echo ============================================================
echo.
echo   Next steps:
echo     - Dev server :  npm run dev
echo     - Build      :  npm run build
echo     - Preview    :  npm run preview
echo.
echo   Then open  http://127.0.0.1:5173  in your browser.
echo.

REM ---------------------------------------------------------------------
REM  Offer to launch the dev server
REM ---------------------------------------------------------------------
set /p LAUNCH="Launch the dev server now? [Y/n] "
if /i "!LAUNCH!"=="" set LAUNCH=Y
if /i "!LAUNCH!"=="Y" (
  echo.
  echo Launching Vite dev server...  Ctrl+C to stop.
  echo.
  npm run dev
) else (
  echo.
  echo Run  npm run dev  whenever you're ready.
  pause
)

endlocal
