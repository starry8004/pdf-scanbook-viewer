# PDF 북 뷰어

PDF 전용 웹 뷰어. pdf.js(4.10.38, `vendor/pdfjs/`) 렌더링 + 만화리더식 UX.
설치 없이 브라우저에서 동작하며, PDF는 기기 밖으로 업로드되지 않습니다(브라우저 안에서만 읽음).

**바로 쓰기:** https://starry8004.github.io/pdf-scanbook-viewer/

## 기기별 사용법

| 기기 | 방법 | 서재(폴더 연결) |
|---|---|---|
| Windows / Mac (Chrome·Edge) | 위 주소 접속, 또는 로컬 실행 | ✅ Google Drive 데스크톱 폴더 연결 |
| iPad / iPhone (Safari) | 위 주소 접속 → 공유 › 홈 화면에 추가 | ❌ [열기] → 탐색 › Google Drive 에서 파일 선택 |
| Firefox | 위 주소 접속 | ❌ 파일 열기만 |

- **Google Drive 폴더:** Windows는 `G:\내 드라이브`, Mac은 Finder 사이드바의 Google Drive (Google Drive 데스크톱 앱 필요).
- 읽던 쪽·설정은 **기기·브라우저·주소별로 따로** 저장됩니다 (기기 간 동기화 없음).

## 로컬 실행 (선택)
- Windows: `뷰어_열기.bat` 더블클릭 → `http://127.0.0.1:8765/`
- Mac: `start.command` 더블클릭 (처음엔 `chmod +x start.command` 필요할 수 있음)
- 포트(8765)를 바꾸면 읽던 쪽·연결 폴더 기록이 초기화되니 고정해 둘 것.

## 기능
- 한쪽 / 두쪽 펼침(표지 단독 옵션) / 연속 스크롤(가상화)
- RTL, 90° 회전, 여백 자동 자르기(검은 스캔 테두리 + 흰 여백 제외)
- 폭·쪽·원본 맞춤, 즉시 CSS 확대 → 200ms 후 고해상도 재렌더
- 앞 2펼침 + 뒤 1펼침 프리페치, 캔버스 LRU 캐시
- 반전(다크모드)·밝기·대비
- 책별 마지막 쪽·보기 설정 저장(파일명 기준), 최근 읽은 책, 썸네일 패널
- 드래그 앤 드롭, 클릭 영역 넘김, 드래그 이동, Ctrl+휠 확대

단축키는 뷰어에서 `?`.

## 디버그
`?open=<같은 출처 PDF 경로>&keys=d,c` — 같은 위치의 PDF를 열고 키 입력을 재생.

## 라이선스
`vendor/pdfjs/` 는 Mozilla PDF.js (Apache License 2.0).
