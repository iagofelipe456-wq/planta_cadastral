@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto python
py -3 scripts\gerar_dados.py > "ULTIMA ATUALIZACAO.log" 2>&1
goto fim
:python
python scripts\gerar_dados.py > "ULTIMA ATUALIZACAO.log" 2>&1
:fim
if errorlevel 1 goto erro
type "ULTIMA ATUALIZACAO.log"
echo.
echo Atualizacao concluida. Abra index.html e confira a data no painel direito.
goto encerrar
:erro
type "ULTIMA ATUALIZACAO.log"
echo.
echo A atualizacao falhou. O motivo esta acima e em ULTIMA ATUALIZACAO.log.
:encerrar
pause
