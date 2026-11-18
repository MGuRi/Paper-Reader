# 논문 읽기 도우미 (PDF Split-View Translator) 구현 계획

> [!NOTE]
> **핵심 목표**: PDF 논문을 올리면 **좌측 원문 · 우측 번역본**을 Split View로 동시에 보면서 끊김 없이 읽고, **원문 ↔ 번역본 양방향 호버 하이라이트**, **형광펜·북마크**, **메인 홈 이어보기**를 지원하는 로컬 논문 리더 계획서입니다.

---

## 1. 화면 구성 (3-View / Tab 구조)

### ① 메인 홈 (`Home`)
* **원클릭 PDF 업로드 존 (상단)**:
  * 큰 **드래그 앤 드롭** 영역 (클릭 시 파일 탐색기 열림).
  * *(선택)* arXiv 링크/PDF URL 입력 시 자동 다운로드 후 바로 열기.
* **최근 열은 PDF 목록 (`Recent PDFs`, 하단)**:
  * 카드/리스트 형태로 **논문 제목**, **마지막 읽은 페이지**(`p.5 / 14`), **번역 진행률**, **형광펜/북마크 개수**, **상태 배지**(`읽는 중` / `완독` — 클릭 시 즉시 상태 전환 가능) 표시.
  * 클릭 시 마지막으로 보던 페이지의 Split View 상태로 즉시 복귀.

### ② 논문 기록 & 검색 (`Library`)
* **통합 검색바 & 보기 모드 전환**:
  * **통합 검색**: **논문 제목 · 저자 · 분야/주제 태그**, **내가 친 형광펜 문장·메모**, **번역된 본문 내용**까지 로컬 캐시에서 한 번에 검색 (클릭 시 해당 페이지 Split View로 바로 점프).
  * **보기 모드 토글 (`간단히 보기 | 상세 보기`)**:
    * **간단히 보기 (Compact)**: 논문 제목 · 상태 배지(`읽는 중`/`완독`) · 진행률만 한 줄 리스트로 밀도 있게 모아보기.
    * **상세 보기 (Detailed)**: **연구 분야 분류 태그**(예: `3D Vision`, `NLP`, `Graphics`, `Multimodal` — AI 자동 분류 + 수동 수정 가능), **20자 이내 초간단 1줄 요약**(예: `"실시간 3D 가우시안 렌더링"`, `"단안 깊이 추정 파운데이션"`), 형광펜 스니펫, 저장된 질문/댓글 미리보기(`Copy AI Prompt` 버튼 포함)까지 한눈에 표시.
* **필터 & 정렬**:
  * 상태 필터: `전체` · `읽는 중` · `완독` · `북마크 있음`
  * 분야/주제 태그 칩 필터 + 정렬(최근 열람순 / 추가일순 / 완독률순)
* **읽기 기록 관리**:
  * 논문별 읽은 날짜, 한 줄 총평(Review), 누적 형광펜·북마크 요약 확인 및 상태(`읽는 중`/`완독`) 변경.

### ③ Split View 리더 (`Reader`)
* **상단 툴바**:
  * 홈으로 / 논문 제목 / 페이지 이동 (`< 3 / 12 >`)
  * **스크롤·페이지 동기화 토글** (`Sync ON/OFF`)
  * **북마크 토글** (현재 페이지 북마크 추가/해제)
  * **완료 표시 버튼 (`Done` / `완독`)**: 논문을 다 읽었을 때 원클릭으로 완료 상태 토글 (홈/기록 탭에 즉시 반영)
  * **사이드바 토글** (북마크 목록 & 형광펜 모아보기 드로어)
  * 번역 상태 표시 및 **현재 페이지 재번역** 버튼
* **좌측 패널 — PDF 원문 뷰어**:
  * `PDF.js` 기반 렌더링 + 투명 텍스트/블록 오버레이 레이어.
  * 텍스트 드래그 시 **형광펜 색상 선택 플로팅 바** 표시.
* **중앙 분할선 (Resizer)**:
  * 드래그로 좌우 패널 비율 자유 조절 (`50:50`, `40:60` 등).
* **우측 패널 — 번역본 & 요약본 뷰어**:
  * 상단 세그먼트 토글(`번역본 | 요약본`)로 전환 (또는 별도 요약본 페이지로 열람).
  * **번역본**: `Markdown` + `KaTeX` 수식 렌더링. 원문의 문단 블록과 1:1로 매핑된 블록 단위로 렌더링되며, 원문/번역본 어느 쪽에 **마우스를 올리든 반대편 대응 영역이 동시에 하이라이트**됨.
  * **요약본 (`Summary`, `review-paper` 스킬 규격 반영)**: `summary.md`를 로드해 구조화된 리뷰 페이지로 렌더링(미생성 시 원클릭 생성).
    * **메타데이터 헤더**: 논문 제목, `arXiv / Conference`, `Authors`, `Official Code` 링크.
    * **상단 3대 핵심 질문 요약 카드**: ① 해결하려는 문제(`Problem`) ② 핵심 기술(`Solution`) ③ 후속 발전 및 영향(`Evolution & Impact`).
    * **4대 세부 분석 섹션**: `1. 논문 개요 & 문제 정의` → `2. 핵심 아이디어 & 방법론`(파이프라인, 직관적 비유, 수식 기호별 분해, Baseline 비교 표) → `3. 실험 설계 및 결과 분석`(Ablation Study 포함) → `4. 비판적 고찰 & 확장성`.
    * **하단 결론 카드**: `핵심 3줄 요약` + `주목할 점 및 주의사항(Points to Note)`.

---

## 2. 번역 & 요약 프롬프트 규칙

### 2-1. 페이지 번역 프롬프트 (원문 보존 & 자연스러운 전문 번역)

번역 요청 시 아래 규칙을 시스템 프롬프트로 고정해 **원문의 정확성을 해치지 않으면서 읽기 편한 번역**과 **블록 매핑용 JSON 출력**을 동시에 얻습니다.

```text
당신은 컴퓨터 비전, 그래픽스, AI 분야의 학술 논문 전문 번역가입니다.
주어진 논문 페이지(이미지와 원문 블록 목록)를 아래 규칙에 따라 한국어로 번역하세요.

[번역 핵심 규칙]
1. 원문 절대 보존:
   - 내용을 임의로 생략, 축약, 과장하거나 추측하여 덧붙이지 마세요.
   - 조건절, 한정어(only, approximately, up to, under the assumption 등), 수치, 비교 표현의 논리적 의미를 원문 그대로 정확히 유지하세요.
2. 전문 용어 & 고유명사 원어 유지:
   - 기술 용어, 모델/모듈명, 학술 개념(예: Gaussian Splatting, Covariance, Pipeline, Ground Truth, Ablation Study, Loss Function, Rendering 등)은 억지로 한국어로 바꾸지 말고 영어 원어를 그대로 사용하세요.
   - 문맥상 처음 등장해 설명이 필요할 때만 `원어(짧은 한국어)` 형태로 쓰고, 이후에는 원어를 유지하세요.
   - 논문에서 통용되는 외래어 표현이 더 자연스러운 경우에만 자연스럽게 혼용하세요.
3. 수식·기호·참조 보존:
   - 모든 수식과 기호는 LaTeX(`$...$`, `$$...$$`)으로 원문과 동일하게 유지하세요.
   - 그림/표/수식/참고문헌 참조(`Fig. 3`, `Table 1`, `Eq. (4)`, `[12]`)는 원문 표기 그대로 두세요.
4. 레이아웃 순서:
   - 2단(Two-column) 문서의 경우 실제 읽기 순서(좌측 단 위→아래, 이어서 우측 단 위→아래)를 지켜 번역하세요.

[출력 형식]
반드시 아래 JSON 배열 형식으로만 응답하세요. 각 `block_id`는 입력으로 주어진 원문 블록과 1:1로 대응해야 합니다.
[
  {
    "block_id": "p1_b1",
    "type": "heading | paragraph | caption | equation | list",
    "translated_md": "번역된 마크다운 텍스트 (수식은 $...$ 또는 $$...$$)"
  }
]
```

### 2-2. 논문 요약 프롬프트 (`review-paper` 스킬 규격)

우측 `Summary` 탭(`summary.md`) 생성 시, Antigravity 사전 생성과 앱 내 Gemini API 폴백 모두 `review-paper` 스킬의 교육·구조 원칙을 동일하게 따릅니다.

```text
당신은 인공지능·머신러닝·컴퓨터 비전 분야의 전문 연구자이자 친절한 튜터입니다.
AI/컴퓨터공학 학부 2학년 전공자가 직관적으로 이해할 수 있도록 논문을 체계적으로 분석하여 Markdown으로 작성하세요.

[핵심 작성 원칙]
1. Intuition First: 난해한 수식이나 아키텍처를 설명하기 전에 일상생활의 비유나 시각적 비유를 먼저 제시하세요.
2. 전문 용어 원문 유지: 기술 용어(예: Self-Attention, Inductive Bias, Covariance)는 영어 원문을 유지하고, 필요 시 괄호 안에 짧은 한글 해설을 병기하세요.
3. 수식 단계별 분해: 모든 수식은 KaTeX(`$...$`, `$$...$$`)으로 표기하고, 각 기호(Notation)의 차원과 의미를 목록 또는 표로 해체해 설명하세요.

[필수 출력 구조 — summary.md]
# [Paper Review] 논문 제목 (영문 약칭)
> **arXiv / Conference**: ... | **Authors**: ... | **Official Code**: ...

## 🚀 3대 핵심 질문 요약
1. **어떤 문제를 해결하고자 하였는가? (Problem)**
2. **어떤 핵심 기술을 사용하여 해결하였는가? (Solution)**
3. **향후 어떤 방향으로 발전되었는가? (Evolution & Impact)**

## 1. 📌 논문 개요 & 문제 정의 (연구 배경 · Baseline 한계 · 핵심 문제)
## 2. ⚙️ 핵심 아이디어 & 방법론 (전체 파이프라인 · 직관적 비유 · 핵심 수식 분해 · Baseline 비교 표)
## 3. 📊 실험 설계 및 결과 분석 (평가 환경/지표 · 정량/정성 해석 · Ablation Study)
## 4. 💡 비판적 고찰 & 확장성 (한계점 · 후속 발전 방향)
## 🏁 요약 및 핵심 정리 (핵심 3줄 요약 · 주목할 점 및 주의사항 Points to Note)
```

---

## 3. 핵심 인터랙션 설계

### ① 양방향 마우스 호버 하이라이트 (원문 ↔ 번역본)
원문과 번역본이 1:1로 정확히 짝지어지도록 **블록 ID(`block_id`) 기반 매핑**을 사용합니다.

1. **원문 블록 추출 & 정규화 좌표(`bbox`) 저장**:
   * 앱 런타임에서는 외부 Python 의존성 없이 **`pdfjs-dist`(`services/pdf-blocks.js`)**로 텍스트 아이템을 추출하고, **2단(Two-column) 읽기 순서 정렬 + Y-gap/X-overlap 기반 문단 클러스터링**을 수행해 `{ block_id, text, bbox: [x_norm, y_norm, w_norm, h_norm] }` 생성. *(Antigravity 사전 생성 파이프라인에서는 `PyMuPDF` 활용 가능)*
   * **정규화 좌표(`0.0 ~ 1.0`)**: 페이지 너비·높이 대비 비율로 저장해 줌 배율(`100%`, `125%`, `Fit Width`)이나 창 리사이즈 시에도 오버레이가 어긋나지 않도록 함.
2. **좌측 원문 오버레이**:
   * PDF 페이지 위에 각 `block_id`의 정규화 `bbox` 좌표에 맞춰 투명 `<div>` 레이어를 배치.
3. **우측 번역본 블록**:
   * 프롬프트 응답 JSON의 각 항목을 `<div data-block-id="p1_b1">` 형태로 렌더링.
4. **호버 동기화**:
   * 좌측 또는 우측 블록에 `mouseenter` 이벤트 발생 시, 상태 `hoveredBlockId = "p1_b1"` 업데이트 → 양쪽 패널에서 동일한 `block_id`를 가진 요소에 하이라이트 스타일(예: 은은한 앰버/블루 배경 + 좌측 보더) 즉시 적용.

### ② 형광펜 (Highlighter) & 북마크 (Bookmark)
* **형광펜**:
  * 원문 텍스트 또는 번역본 텍스트를 드래그하면 작은 플로팅 바(노랑 · 초록 · 분홍 · 파랑 + 한 줄 메모 + `댓글/질문` 버튼) 표시.
  * **좌표/오프셋 분기 저장**:
    * **원문(`target: "original"`)**: 고정 레이아웃이므로 정규화 좌표 `rects: [[x_norm, y_norm, w_norm, h_norm], ...]`로 PDF 위에 렌더링하고, 매핑된 번역본 블록 옆에도 작은 컬러 인디케이터 표시.
    * **번역본(`target: "translated"`)**: 중앙 리사이저 드래그 시 줄바꿈이 유동적으로 변하므로 `rects` 대신 **`block_id` + 문자 오프셋(`startOffset`, `endOffset`)** 기반으로 저장·복원.
  * 저장 구조: `{ id, pdf_hash, page, block_id, target: "original" | "translated", text, rects?, startOffset?, endOffset?, color, note, created_at }`
* **북마크**:
  * 상단 툴바의 북마크 아이콘(`Ctrl + D` 등)으로 현재 페이지 북마크 토글 + 선택적 짧은 라벨 입력.
  * 좌/우 접이식 사이드바에서 **북마크 탭** / **형광펜 탭** / **댓글·질문 탭**을 전환하며 클릭 한 번으로 해당 페이지·위치로 점프.

### ③ 댓글 · 질문 메모 & AI 질문 복사
* **인라인 댓글/질문 달기**:
  * 원문이나 번역본 텍스트를 드래그했을 때 뜨는 플로팅 바에 **`댓글/질문`** 버튼 배치 (또는 문단 블록 우측 `+` 아이콘 클릭).
  * 클릭 시 작은 입력창이 열려 궁금한 점이나 메모를 바로 적고 저장 (`annotations.json`에 `block_id`, 선택 원문·번역본과 함께 저장).
  * 댓글이 달린 문단 옆에는 말풍선 배지가 표시되며, 해결 여부를 `해결됨`으로 체크 가능.
* **원클릭 `AI 질문 복사` 버튼**:
  * 각 댓글 카드 옆(및 사이드바 상단 `미해결 질문 전체 복사`)에 **질문 복사 버튼** 배치.
  * 클릭 시 AI에게 바로 붙여넣어 정확한 답변을 받을 수 있도록 논문 제목·페이지·원문·번역본·내 질문이 자동 포맷팅되어 클립보드에 복사됨:

```text
[논문] 3D Gaussian Splatting for Real-Time Radiance Field Rendering (p.4)
[원문 발췌] "..."
[번역본] "..."
[질문] (내가 작성한 댓글/질문 내용)
위 문맥을 바탕으로 내 질문에 대해 알기 쉽게 설명해줘.
```

### ④ 수식 우클릭 복사 메뉴 (`LaTeX`)
* **적용 대상**: 우측 패널의 모든 KaTeX 수식(`.katex` / `.katex-display`) 및 좌측 PDF에서 `type: "equation"`으로 매핑된 수식 블록.
* **동작**: 수식 위에서 **마우스 우클릭** 시 작은 컨텍스트 메뉴 팝업 표시:
  * `LaTeX 복사 ($$...$$ 포함)` — 마크다운/노션 붙여넣기용
  * `순수 수식만 복사` — Word/한글 수식 편집기용
  * `수식 설명 질문 복사` — 해당 수식과 주변 문맥을 AI 질문 프롬프트로 복사
* **구현 팁**: KaTeX 렌더링 시 원본 LaTeX 문자열을 `data-latex="..."` 속성에 함께 저장해 두면 우클릭 즉시 0ms 만에 정확하게 복사 가능.

---

## 4. "기다리지 않는" PDF 번역 파이프라인

1. **즉시 열람**: PDF를 열면 좌측 원문은 0초 만에 렌더링.
2. **우선순위 번역 큐**: 현재 보고 있는 페이지 → 다음 1~2페이지 → 나머지 페이지를 백그라운드에서 순차 번역.
3. **로컬 캐싱**: 번역 결과(JSON), 형광펜, 북마크, 마지막 읽은 페이지를 로컬 폴더(`papers/<pdf_hash>/`)에 저장해 다시 열 때 API 재호출 없이 즉시 복원.

### 읽기 진행도 측정 (체류 시간 · 활동 기반)
* **실제 읽은 페이지 판정 (`read_pages`)**: 단순 스크롤 통과는 제외하고, 해당 페이지에서 **일정 시간(예: 15초 이상) 체류**하거나 **호버 하이라이트·형광펜·번역 확인** 활동이 발생했을 때만 `read_pages` 목록에 추가. (창이 비활성화·최소화된 상태에서는 체류 타이머 일시 정지)
* **진행률 계산**: `read_pages.length / body_end_page` (`References`/`Appendix` 시작 전 본문 페이지를 기본 분모로 사용하며, 필요 시 전체 페이지 기준 전환 가능).
* **이어보기 & 완독**: 마지막으로 보던 위치(`last_page`)는 별도 저장해 클릭 시 즉시 복귀하며, 본문 페이지 모두 읽음 또는 사용자 **완독** 클릭 시 `Done`으로 전환.

---

## 5. 단계별 구현 로드맵

### Phase 1 — 메인 홈 + Split View + 기본 번역 (MVP)
1. **프로젝트 셋업 & 설정**: Electron + Vanilla JS 골격, 다크/라이트 테마 토글, **설정 모달**(Gemini API Key `safeStorage` 암호화 저장, 모델 선택)
2. **메인 홈 (`Home`)**: `.pdf` 드래그 앤 드롭 업로드 + 최근 읽은 PDF 카드 목록
3. **Split View (`Reader`)**: 좌측 `PDF.js` 뷰어 + 우측 `Markdown/KaTeX` 번역 패널(수식 전처리 토큰화 포함) + 중앙 리사이저
4. **페이지 번역 연동**: 번역 프롬프트 규칙 적용 + 로컬 JSON 캐싱 + 429 Rate Limit 재시도/백오프

### Phase 2 — 2단 블록 추출 + 양방향 호버 하이라이트 + 진행도 측정
1. `services/pdf-blocks.js` 구현: 2단 읽기 순서 정렬, 문단 클러스터링, 정규화 `bbox` 추출 및 좌측 투명 오버레이
2. `hoveredBlockId` 상태 공유를 통한 원문 ↔ 번역본 양방향 호버 하이라이트
3. 페이지/스크롤 동기화(`Sync ON/OFF`) + 우선순위 백그라운드 프리페치 큐
4. 체류 시간·활동 기반 읽기 진행률(`read_pages / body_end_page`) 및 `Reading`/`Done` 상태 전환

### Phase 3 — 형광펜 · 북마크 · 댓글/질문 · 수식 복사 · `Library`
1. 드래그 형광펜(원문 정규화 좌표 / 번역본 오프셋 분기) 및 북마크 저장·사이드바(`Bookmarks | Highlights | Notes`) 모아보기
2. 인라인 댓글/질문 작성 + 원클릭 **`AI 질문 복사`** (`Copy AI Prompt`)
3. 수식 우클릭 **`LaTeX` 복사 메뉴**(`Copy LaTeX`, `Copy Equation`, `Copy AI Question`)
4. `Library` 탭 구현: 간단히/상세 보기, 태그·상태 필터, 제목/형광펜/댓글/번역 본문 통합 검색

### Phase 4 — `Summary` 탭 · arXiv 연동 · `.paperpkg` & Windows 패키징
1. **`Summary` 탭**: `review-paper` 규격 `summary.md` 렌더링 및 원클릭 생성/재생성
2. **arXiv URL 자동 다운로드** & 번역본+형광펜 통합 `.md` 노트 내보내기
3. **`.paperpkg`(ZIP) 임포트/익스포트** (Antigravity 사전 생성 패키지 드래그 앤 드롭 등록)
4. `electron-builder` 기반 Windows `.exe` 빌드 및 `mockups/` 앱 아이콘(`icon.ico`) 적용

---

## 6. Windows 데스크톱 앱 기술 스택 & 프로젝트 구조

이미 `Archive-Hub`에서 사용 중인 **Electron** 기반에 `PDF.js`·`KaTeX`를 결합하면 Windows 환경에서 가장 빠르고 익숙하게 구현할 수 있습니다.

* **프레임워크 (확정)**: `Electron` + **Vanilla JS / HTML / CSS** (`Archive-Hub`와 동일한 무번들러·경량 구조; `contextIsolation: true`, `nodeIntegration: false` 보안 설정 적용)
* **핵심 라이브러리**:
  * `pdfjs-dist` — PDF 원문 렌더링, 텍스트 레이어, 2단 블록 정규화 좌표 추출
  * `marked` + `katex` — `marked.parse()` 전 `$...$` / `$$...$$` 수식을 먼저 토큰화하여 `_`/`*` 마크다운 충돌을 방지하고 `<span class="katex-wrap" data-latex="...">`로 래핑. KaTeX CSS·폰트는 오프라인 동작을 위해 로컬 `node_modules`에서 직접 로드
  * `@google/genai` (또는 `fetch`) — Gemini 멀티모달 페이지 번역/요약 폴백 (429 Rate Limit 지수 백오프 재시도 포함)
  * `electron-builder` — Windows `.exe` 설치/포터블 파일 빌드
* **로컬 데이터 저장 위치**: `%APPDATA%/PaperReader/`
  * `config.json` — 테마, 모델 설정 및 Electron `safeStorage`로 암호화된 Gemini API Key
  * `recent.json` — 전체 논문 인덱스(SHA-256 `pdf_hash`, 제목, 태그, 1줄 요약, 마지막 페이지, 진행률, 상태)
  * `papers/<pdf_hash>/` (표준 패키지 구조 — `.paperpkg`와 1:1 호환):
    * `meta.json` — 논문 메타데이터(`body_end_page`, `last_page`, `read_pages`, `status`, `tags`, `review`)
    * `blocks.json` — 페이지·블록별 원문 텍스트 및 정규화 `bbox`
    * `translations.json` — 페이지·블록별 번역 캐시 (전문 검색 대상)
    * `annotations.json` — 형광펜(좌표/오프셋·색상·메모), 북마크, 댓글/질문 데이터 (전문 검색 대상)
    * `summary.md` — `review-paper` 규격 논문 구조화 요약본
    * `paper.pdf` — 원본 PDF 복사본 (원본 이동/삭제 대비)

```text
paper-reader/
├── main.js                   # Electron 메인 프로세스, 창 관리, IPC 핸들러, safeStorage
├── preload.js                # contextBridge API (파일/패키지 선택, 번역·요약, 검색, 저장)
├── assets/
│   └── icon.ico              # Dark Warm Minimal 앱 아이콘
├── services/
│   ├── pdf-blocks.js         # pdfjs-dist 기반 2단 정렬 · 문단 클러스터링 · 정규화 bbox 추출
│   ├── translator.js         # Gemini 멀티모달 번역/요약 큐, 재시도, 프롬프트 관리
│   └── storage.js            # config/recent.json, papers/<hash>/ 캐시, .paperpkg, 통합 검색
├── src/
│   ├── index.html
│   ├── styles.css            # Split View, 호버 하이라이트, 형광펜, 다크/라이트 테마
│   ├── home.js               # 홈 화면 (드래그 앤 드롭 업로드 + 최근 PDF 목록)
│   ├── library.js            # 논문 기록 & 검색 탭 (제목/형광펜/댓글/번역본 검색, 필터)
│   └── reader.js             # Split View 리더 (PDF.js + 번역/요약 패널 + 호버/형광펜/수식 복사)
└── package.json
```

---

## 7. 디자인 시스템 (`Archive Hub` — Dark Warm Minimal 유지)

기존 `Archive-Hub`의 차분하고 따뜻한 다크 미니멀 톤을 그대로 계승해, 장시간 논문을 읽어도 눈이 피로하지 않도록 설계합니다.

### 컬러 & 타이포그래피 토큰 (`styles.css`)
```css
:root {
  --bg-surface: #1C1C1B;
  --bg-elevated: #252523;
  --bg-hover: rgba(255, 255, 255, 0.05);
  --border-hairline: #2F2F2C;
  --border-strong: #444440;
  --text-primary: #EFECE6;
  --text-secondary: #A3A099;
  --text-muted: #706E68;
  --accent: #C79B85;
  --accent-muted: rgba(199, 155, 133, 0.14);
  --green: #6EE7B7;
  --amber: #E5A95C;
  --rose: #E06C75;
  --radius-md: 9px;
  --radius-sm: 6px;
}

/* 라이트 모드 (Warm Paper Minimal) */
[data-theme="light"] {
  --bg-surface: #F7F5F0;
  --bg-elevated: #FFFFFF;
  --bg-hover: rgba(0, 0, 0, 0.04);
  --border-hairline: #E6E2D8;
  --border-strong: #CFC9BC;
  --text-primary: #1F1E1C;
  --text-secondary: #5C5952;
  --text-muted: #8C887E;
  --accent: #B07D66;
  --accent-muted: rgba(176, 125, 102, 0.14);
  --green: #10B981;
  --amber: #D97706;
  --rose: #E11D48;
}
```
* **원클릭 테마 전환**: 상단 바 우측에 해/달 아이콘 토글 버튼을 배치해 **다크 모드(기본)** ↔ **라이트 모드**를 즉시 전환하고 설정을 로컬에 자동 저장.
* **앱 로고/아이콘**: Dark Warm Minimal 톤의 **펼쳐진 책 + 테라코타 북마크 + 스파크** 심볼 (`icon.ico` / `icon.png` 적용).
* **폰트**: `'IBM Plex Sans KR', 'Pretendard Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
* **UI 디테일**:
  * **업로드 존 & 카드**: `--bg-elevated` 바탕에 `--border-hairline` 테두리, 호버 시 `--border-strong` 또는 `--accent`로 은은하게 강조.
  * **양방향 호버 하이라이트**: 원문/번역본 호버 시 `--accent-muted` 배경 + 좌측 `2px solid var(--accent)` 인디케이터로 시선 방해 없이 짝을 표시.
  * **형광펜 4색**: 톤이 튀지 않게 기존 팔레트(`--amber`, `--green`, `--rose`, `--accent`)의 반투명(`rgba(..., 0.22)`) 버전 사용.
  * **원문 PDF 눈부심 방지 옵션**: 다크 모드 사용 시 필요에 따라 좌측 PDF 캔버스에 은은한 다크/세피아 필터 토글을 제공해 우측 번역 패널과 이질감을 줄임.

### 마이크로 인터랙션 & 모션 가이드
* **공통 이징**: `transition: all 180ms cubic-bezier(0.22, 1, 0.36, 1)` (빠르고 부드러운 감속감 유지, 읽기 방해 최소화).
* **버튼 & 클릭 피드백**:
  * 모든 버튼/카드에 미세한 눌림 모션(`active: transform: scale(0.97)`) 및 호버 시 테두리·배경 점등.
  * **`Mark Done` / `완독` 버튼**: 클릭 시 체크 아이콘 스프링 바운스(`scale(0.85 → 1.15 → 1)`) + 카드 테두리 은은한 에메랄드(`--green`) 1회 글로우 펄스.
  * **`Copy LaTeX` / `Copy AI Prompt`**: 클릭 시 버튼 라벨이 `"Copied ✓"`로 부드럽게 크로스페이드 전환(1.5초 후 복귀).
* **탭 · 토글 · 사이드바**:
  * `Home | Library | Reader`, `Translation | Summary`, `간단히 | 상세` 전환 시 **슬라이딩 필(Sliding Pill) 인디케이터** 이동 모션.
  * 우측 사이드바(`Bookmarks | Highlights | Notes`) 및 인라인 댓글 입력창은 부드러운 슬라이드-인/아코디언 확장.
* **리더 & 드래그 앤 드롭**:
  * 파일 드래그 오버 시 업로드 존 점선 테두리가 `--accent`로 빛나며 미세 확대(`scale(1.01)`).
  * 양방향 호버 하이라이트 전환 시 `120ms` 페이드로 부드럽게 점등.
  * 수식 우클릭 메뉴 & 형광펜 플로팅 바는 `opacity: 0 → 1`, `translateY(4px → 0)` 팝업 모션.

---

## 8. Antigravity 사전 생성 연동 (API 비용 0원 · 고성능 모델 활용)

앱 내부 API 호출 한도/비용 걱정 없이 **Antigravity의 고성능 모델**로 번역과 요약을 미리 생성해 앱으로 넘길 수 있는 하이브리드 구조입니다.

1. **표준 데이터 포맷 공유**:
   * 앱이 읽는 캐시 구조(`translations.json`, `summary.md`, `meta.json` + 원본 `paper.pdf`)를 표준 규격으로 통일.
2. **2가지 전달 방식**:
   * **로컬 PC Antigravity 사용 시 (자동 주입)**: Antigravity에게 PDF를 주면 블록 좌표 추출 + 번역 JSON + `review-paper` 요약본을 생성해 `%APPDATA%/PaperReader/papers/<pdf_hash>/`에 직접 저장 → 앱을 열면 **API 호출 0회, 대기 시간 0초**로 즉시 열람.
   * **원격/클라우드 환경 또는 파일 이동 시 (`.paperpkg` 임포트)**: 위 파일들을 하나의 `.paperpkg`(ZIP) 패키지로 묶어 내보내고, `PaperReader` 홈 화면의 드래그 앤 드롭 존에 끌어다 놓으면 바로 `Library`에 등록됨.
3. **하이브리드 폴백**:
   * 미리 생성해 둔 번역본이 있으면 100% 캐시에서 로드하고, 급하게 바로 열어봐야 하는 PDF만 앱 내 Gemini API로 실시간 번역.



