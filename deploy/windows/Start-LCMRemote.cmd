@echo off
where pwsh.exe >nul 2>nul
if errorlevel 1 (
 echo PowerShell 7 is required. Install it, then run this file as administrator.
 pause
 exit /b 1
)
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LCMRemote.ps1" -ExpectedHostname "%COMPUTERNAME%"
set "lcm_exit=%ERRORLEVEL%"
if not "%lcm_exit%"=="0" pause
exit /b %lcm_exit%
