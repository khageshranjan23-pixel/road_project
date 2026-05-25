@echo off
title Fix GPU — RTX 50xx Blackwell PyTorch Upgrade
color 0A
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║  Fixing PyTorch for RTX 5050 Blackwell GPU          ║
echo  ║  Installing PyTorch 2.7 + CUDA 12.8                 ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: Activate conda env if it exists, else use current python
where conda >nul 2>&1
if %errorlevel% == 0 (
  echo [1/3] Activating conda environment: roadsafe
  call conda activate roadsafe
) else (
  echo [1/3] Using current Python environment
)

:: Uninstall old CPU/wrong-CUDA torch
echo [2/3] Removing old PyTorch build...
pip uninstall torch torchvision torchaudio -y

:: Install PyTorch with CUDA 12.8 (supports Blackwell RTX 50xx)
echo [3/3] Installing PyTorch with CUDA 12.8 for RTX 50xx Blackwell...
echo       This will download ~2.5 GB - please wait...
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128

echo.
echo  ── Verifying GPU ──────────────────────────────────────
python -c "import torch; cuda=torch.cuda.is_available(); print('  CUDA:', cuda); t=torch.zeros(1).cuda() if cuda else None; print('  Kernel test:', 'PASSED' if cuda else 'CPU mode'); print('  GPU:', torch.cuda.get_device_name(0) if cuda else 'N/A')"

echo.
echo  ── Done! Now run the app ──────────────────────────────
echo    python app.py
echo    Then open: http://localhost:5000
echo  ───────────────────────────────────────────────────────
echo.
pause
