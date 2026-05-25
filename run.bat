@echo off
title RoadSafe AI — Launcher
color 0B
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║       RoadSafe AI — Road Crossing Predictor         ║
echo  ║       YOLOv8x + GPU (CUDA) + ByteTrack              ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: ── Find Python ────────────────────────────────────────────────────────────
set PYTHON=
for %%P in (python3 python py) do (
  if not defined PYTHON (
    %%P --version >nul 2>&1 && set PYTHON=%%P
  )
)
if not defined PYTHON (
  echo [ERROR] Python not found. Please install Python 3.10+ and add it to PATH.
  pause & exit /b 1
)
echo [OK] Found Python: %PYTHON%

:: ── Create venv ────────────────────────────────────────────────────────────
if not exist "venv\" (
  echo [1/5] Creating virtual environment...
  %PYTHON% -m venv venv
  if %errorlevel% neq 0 (
    echo [ERROR] Failed to create venv.
    pause & exit /b 1
  )
)

:: ── Activate ───────────────────────────────────────────────────────────────
echo [2/5] Activating virtual environment...
call venv\Scripts\activate.bat

:: ── Upgrade pip ────────────────────────────────────────────────────────────
echo [3/5] Upgrading pip...
python -m pip install --upgrade pip -q

:: ── Install PyTorch with CUDA 12.1 ────────────────────────────────────────
echo [4/5] Installing PyTorch with CUDA support (this may take a few minutes on first run)...
python -c "import torch; torch.cuda.is_available()" >nul 2>&1
if %errorlevel% neq 0 (
  echo     Downloading PyTorch CUDA build...
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121 -q
) else (
  echo     PyTorch already installed.
)

:: ── Install other deps ─────────────────────────────────────────────────────
echo [5/5] Installing project dependencies...
pip install -r requirements.txt -q

:: ── GPU info ───────────────────────────────────────────────────────────────
echo.
echo  ── GPU Status ─────────────────────────────────────────
python -c "import torch; cuda=torch.cuda.is_available(); print('  CUDA:', cuda); print('  GPU:', torch.cuda.get_device_name(0) if cuda else 'Not available — will use CPU')"
echo  ───────────────────────────────────────────────────────
echo.

:: ── Download YOLOv8x model (if not cached) ───────────────────────────────
echo  Checking YOLOv8x model (downloads ~130MB on first run)...
python -c "from ultralytics import YOLO; YOLO('yolov8x.pt')" >nul 2>&1

echo.
echo  ═══════════════════════════════════════════════════════
echo    Server starting at:  http://localhost:5000
echo    Open your browser:   http://localhost:5000
echo    Press Ctrl+C to stop
echo  ═══════════════════════════════════════════════════════
echo.

python app.py

pause
