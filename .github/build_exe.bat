@echo off
setlocal enableextensions
rem ---------------------------------------------------------------
rem OpenBoard Windows build script (MSVC + WebView2)
rem
rem Why this lives in the repo as a real .bat file instead of being
rem assembled by PowerShell inside the workflow:
rem   When PowerShell writes a multi-line/array value to disk, line
rem   endings, code page and YAML block-scalar indentation all take
rem   part. A path containing spaces easily ends up broken across
rem   lines, and CI fails with
rem     'C:\Program' is not recognized as an internal or external command
rem   with no hint that the string assembly was at fault.
rem   As a file, the content is exactly what you see.
rem ---------------------------------------------------------------

if "%~1"=="" (
  echo ::error::usage: build_exe.bat "C:\path\to\vcvars64.bat"
  exit /b 2
)

set "VCVARS=%~1"
if not exist "%VCVARS%" (
  echo ::error::vcvars64.bat not found: %VCVARS%
  exit /b 2
)

echo === vcvars64: %VCVARS% ===
call "%VCVARS%"
if errorlevel 1 (
  echo ::error::vcvars64 init failed
  exit /b 1
)

echo === rc.exe ===
rc /nologo resource.rc
if errorlevel 1 (
  echo ::error::rc failed
  exit /b 1
)

echo === cl.exe ===
cl /nologo /std:c++17 /O2 /EHsc /DUNICODE /D_UNICODE ^
   /I"webview2_sdk\build\native\include" ^
   main.cpp resource.res ^
   /Fe:OpenBoard.exe ^
   /link /SUBSYSTEM:WINDOWS ^
   /LIBPATH:"webview2_sdk\build\native\x64" ^
   WebView2LoaderStatic.lib ^
   user32.lib shell32.lib ole32.lib oleaut32.lib advapi32.lib gdi32.lib
if errorlevel 1 (
  echo ::error::cl failed
  exit /b 1
)

echo === cl done ===
exit /b 0
