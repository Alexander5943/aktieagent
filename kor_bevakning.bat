@echo off
REM Kor aktieagenten pa bevakningslistan. Startas av Windows Schemalaggaren varje mandag.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not exist rapporter mkdir rapporter
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% aktieagent.py --file bevakningslista.txt --out-dir rapporter >> rapporter\logg.txt 2>&1
