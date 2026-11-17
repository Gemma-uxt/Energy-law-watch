# Energy-law-watch

에너지 관련 입법·행정예고와 전력시장 규칙 개정을 하루 3번(07·12·18시) 자동 수집·분석하는 페이지입니다.
https://gemma-uxt.github.io/Energy-law-watch/

## 수집처
- 국회 입법예고(열린국회정보 API) + 의안정보시스템 심사 단계
- 국민참여입법센터 입법예고·행정예고
- 부처 게시판(산업통상부, 기후에너지환경부, 원자력안전위원회, 국토교통부)
- 전력거래소: 전력시장운영규칙 개정 공고, 규칙개정위원회 회의결과 (첨부 HWP·PDF 본문 읽기)
- 전기위원회: 위원회 개최결과 (첨부 PDF 읽기)

## 설정(Settings → Secrets and variables → Actions)
| 이름 | 필수 | 용도 |
|---|---|---|
| ASSEMBLY_API_KEY | 예 | 열린국회정보 API |
| GEMINI_API_KEY | 권장 | AI 요약·분야 분류·주간 브리핑 |
| TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID | 선택 | 새 건·마감 임박 텔레그램 알림 |

## 파일
- `scripts/collect.mjs` 수집·분석
- `scripts/attach.mjs` 첨부파일(HWP·배포용 HWP·HWPX·PDF, 스캔본 OCR) 글자 추출
- `scripts/keywords.json` 분야 키워드 / `scripts/boards.json` 게시판 목록
- `docs/index.html` 화면, `docs/feed.xml` RSS 피드

키워드를 고친 뒤 `node scripts/collect.mjs --offline`을 실행하면 새로 수집하지 않고 저장된 데이터만 다시 분류합니다.
