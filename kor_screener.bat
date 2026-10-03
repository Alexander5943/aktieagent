@echo off
REM Kor screenern med AI pa topp 10. Schemalaggaren startar den varje dag,
REM men den kor bara en gang per manad (forsta dagen datorn ar pa).
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not exist rapporter mkdir rapporter
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% screener.py --ai-top 10 --out-dir rapporter --manadsvis >> rapporter\logg.txt 2>&1
