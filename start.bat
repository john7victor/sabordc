@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [SABOR] Criando ambiente virtual...
  python -m venv .venv || goto :nopython
  ".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
  echo [SABOR] Instalando dependencias...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
)

echo [SABOR] Iniciando...
".venv\Scripts\pythonw.exe" run.py
exit /b 0

:nopython
echo.
echo  Python nao encontrado. Instale o Python 3.11 ou mais novo:
echo    winget install --id Python.Python.3.12
echo.
pause
exit /b 1

:fail
echo.
echo  Falha ao instalar as dependencias. Rode start.bat de novo.
echo.
pause
exit /b 1
