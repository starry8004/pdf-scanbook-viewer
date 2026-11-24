@echo off
chcp 65001 >nul
title PDF Scanbook Viewer
"C:\apps\Python312\python.exe" "%~dp0serve.py"
