#!/bin/bash
# macOS: Finder에서 더블클릭하면 로컬 서버를 띄우고 브라우저를 엽니다.
cd "$(dirname "$0")"
python3 serve.py
