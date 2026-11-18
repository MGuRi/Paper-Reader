# Antigravity → PaperReader 전달 규격 (`ANTIGRAVITY_SPEC.md`)

PaperReader 앱은 내부에서 Gemini API를 호출하지 않고, **Antigravity가 생성한 로컬 캐시 또는 `.paperpkg`(ZIP) 패키지**를 그대로 읽어 0초 만에 렌더링합니다.

---

## 1. 전달 방법 (2가지 중 택 1)

1. **로컬 PC 직접 주입 (권장)**
   * `%APPDATA%\PaperReader\papers\<pdf_hash>\` 폴더에 아래 파일들을 직접 저장합니다.
   * `pdf_hash` = `paper.pdf` 파일 바이트의 SHA-256 해시 **앞 16자리 소문자 hex**.
2. **`.paperpkg` 패키지 내보내기**
   * 아래 파일들을 루트에 담아 ZIP으로 압축하고 확장자를 `.paperpkg`로 저장한 뒤, PaperReader `Home` 화면에 드래그 앤 드롭합니다.

---

## 2. 폴더 내 표준 파일 구성 (5개 필수 + 1개 선택)

```text
<pdf_hash>/
├── paper.pdf            # [필수] 원본 PDF 파일
├── meta.json            # [필수] 논문 메타데이터 & 읽기 상태
├── blocks.json          # [필수] 페이지별 원문 블록 & 정규화 좌표(bbox)
├── translations.json    # [필수] block_id 1:1 매핑 한국어 번역 JSON
├── summary.md           # [필수] review-paper 스킬 규격 전체 요약 마크다운
└── annotations.json     # [선택] 초기 북마크/형광펜/메모 (없으면 자동 빈 구조 생성)
```

---

## 3. 파일별 상세 JSON / Markdown 규격

### ① `meta.json`
```json
{
  "pdf_hash": "a1b2c3d4e5f60718",
  "title": "3D Gaussian Splatting for Real-Time Radiance Field Rendering",
  "short_title": "3D Gaussian Splatting",
  "authors": "Bernhard Kerbl, Georgios Kopanas, Thomas Leimkuhler, George Drettakis",
  "year": "2023",
  "venue": "ACM TOG (SIGGRAPH 2023)",
  "arxiv_url": "https://arxiv.org/abs/2308.04079",
  "code_url": "https://github.com/graphdeco-inria/gaussian-splatting",
  "tags": ["#3DGS", "#Graphics", "#Rendering"],
  "one_line_summary": "실시간 3D 가우시안 스플래팅 렌더링",
  "review": "",
  "total_pages": 12,
  "body_end_page": 9,
  "last_page": 1,
  "read_pages": [],
  "status": "Reading",
  "attachments": []
}
```
* `body_end_page`: `References` / `Appendix` 직전 마지막 본문 페이지 번호 (진행률 분모).

### ② `blocks.json` (2단 읽기 순서 + 정규화 좌표)
* 페이지 번호 문자열(`"1"`, `"2"`, ...)을 키로 가집니다.
* `bbox`: `[x_norm, y_norm, w_norm, h_norm]` (`0.0 ~ 1.0`, 좌상단 원점 기준 페이지 크기 대비 비율).
* 2단(Two-column) 논문은 **상단 전폭 → 좌측 단(위→아래) → 우측 단(위→아래)** 순서로 배치합니다.

```json
{
  "1": [
    {
      "block_id": "p1_b1",
      "type": "heading",
      "text": "Abstract",
      "bbox": [0.0719, 0.165, 0.4052, 0.021]
    },
    {
      "block_id": "p1_b2",
      "type": "paragraph",
      "text": "Radiance Field methods have revolutionized...",
      "bbox": [0.0719, 0.192, 0.4052, 0.142]
    }
  ]
}
```
* `type`: `"heading" | "paragraph" | "caption" | "equation" | "list"`

### ③ `translations.json` (`block_id` 1:1 매핑)
* `blocks.json`과 동일한 페이지 키 및 `block_id`를 1:1로 맞춥니다.
* **번역 규칙**: 원문 의미·한정어·수치 100% 보존, 전문 용어 영어 원문 유지(필요 시 첫 등장만 `원어(짧은 한국어)`), 모든 수식은 KaTeX(`$...$`, `$$...$$`), 참조(`Fig. 3`, `Eq. (4)`, `[12]`) 원문 유지.

```json
{
  "1": [
    {
      "block_id": "p1_b1",
      "type": "heading",
      "translated_md": "### 초록 (Abstract)"
    },
    {
      "block_id": "p1_b2",
      "type": "paragraph",
      "translated_md": "Radiance Field 기법은 다수의 사진으로 촬영된 장면의 Novel-view Synthesis를 혁신했습니다. 핵심 수식은 $$G(x) = \\exp(-\\frac{1}{2}x^T \\Sigma^{-1} x)$$ 와 같습니다."
    }
  ]
}
```

### ④ `summary.md` (`review-paper` 스킬 규격)
`review-paper` 스킬의 표준 구조를 그대로 따릅니다:
* 파일 헤더 메타데이터 (`# [Paper Review] ...`, `arXiv / Conference`, `Authors`, `Official Code`)
* `## 🚀 3대 핵심 질문 요약` (`Problem` · `Solution` · `Evolution & Impact`)
* `## 1. 📌 논문 개요 & 문제 정의`
* `## 2. ⚙️ 핵심 아이디어 & 방법론` (직관적 비유 · 수식 기호 분해 표 · Baseline 비교 표)
* `## 3. 📊 실험 설계 및 결과 분석` (`Ablation Study` 포함)
* `## 4. 💡 비판적 고찰 & 확장성`
* `## 🏁 요약 및 핵심 정리` (`핵심 3줄 요약` · `Points to Note`)

### ⑤ `annotations.json` *(선택)*
```json
{
  "highlights": [],
  "bookmarks": [],
  "comments": []
}
```
