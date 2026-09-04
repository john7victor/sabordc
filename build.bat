@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PY=.venv\Scripts\python.exe"
REM Compila fora da pasta do projeto: se ela estiver no OneDrive (ou Dropbox),
REM o sincronizador tranca arquivos no meio do build e o PyInstaller morre com
REM "Acesso negado". So o instalador final volta para dist\.
set "WORK=%LOCALAPPDATA%\SABOR-build\work"
set "STAGE=%LOCALAPPDATA%\SABOR-build\dist"

if not exist "%PY%" (
  echo [SABOR] Criando ambiente virtual...
  python -m venv .venv || goto :nopython
)

echo [SABOR] Conferindo dependencias de build...
"%PY%" -m pip install -q -r requirements.txt -r requirements-build.txt || goto :fail

echo.
echo [1/3] Gerando o icone...
"%PY%" tools\make_icon.py || goto :fail

echo.
echo [2/3] Empacotando o aplicativo...
if exist "%STAGE%\SABOR" rmdir /s /q "%STAGE%\SABOR"
"%PY%" -m PyInstaller --noconfirm --clean --distpath "%STAGE%" --workpath "%WORK%" installer\sabor.spec || goto :fail
if not exist "%STAGE%\SABOR\SABOR.exe" (
  echo  O PyInstaller nao produziu SABOR.exe
  goto :fail
)

echo.
echo [3/3] Montando o instalador...
set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "!ISCC!" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "!ISCC!" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not exist "!ISCC!" goto :noinno

if not exist dist mkdir dist
"!ISCC!" /Q "/DDistDir=%STAGE%\SABOR" installer\sabor.iss || goto :fail

echo.
echo ==========================================================
echo  Instalador: dist\ (o .exe com a versao definida em installer\sabor.iss)
echo  Portatil:   %STAGE%\SABOR\
echo ==========================================================
echo.
pause
exit /b 0

:nopython
echo.
echo  Python nao encontrado. Instale o Python 3.11 ou mais novo:
echo    winget install --id Python.Python.3.12
echo.
pause
exit /b 1

:noinno
echo.
echo  Inno Setup 6 nao encontrado. Instale com:
echo    winget install --id JRSoftware.InnoSetup
echo.
echo  O app empacotado ficou pronto em %STAGE%\SABOR\ mesmo assim.
echo.
pause
exit /b 1

:fail
echo.
echo  Build falhou. Veja a mensagem acima.
echo.
pause
exit /b 1
