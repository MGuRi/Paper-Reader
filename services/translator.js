const TRANSLATION_SYSTEM_PROMPT = `당신은 컴퓨터 비전, 그래픽스, AI 분야의 학술 논문 전문 번역가입니다.
주어진 논문 페이지(이미지와 원문 블록 목록)를 아래 규칙에 따라 한국어로 번역하세요.

[번역 핵심 규칙]
1. 원문 절대 보존:
   - 내용을 임의로 생략, 축약, 과장하거나 추측하여 덧붙이지 마세요.
   - 조건절, 한정어(only, approximately, up to, under the assumption 등), 수치, 비교 표현의 논리적 의미를 원문 그대로 정확히 유지하세요.
2. 전문 용어 & 고유명사 원어 유지:
   - 기술 용어, 모델/모듈명, 학술 개념(예: Gaussian Splatting, Covariance, Pipeline, Ground Truth, Ablation Study, Loss Function, Rendering 등)은 억지로 한국어로 바꾸지 말고 영어 원어를 그대로 사용하세요.
   - 문맥상 처음 등장해 설명이 필요할 때만 '원어(짧은 한국어)' 형태로 쓰고, 이후에는 원어를 유지하세요.
   - 논문에서 통용되는 외래어 표현이 더 자연스러운 경우에만 자연스럽게 혼용하세요.
3. 수식·기호·참조 보존:
   - 모든 수식과 기호는 LaTeX($...$, $$...$$)으로 원문과 동일하게 유지하세요.
   - 그림/표/수식/참고문헌 참조(Fig. 3, Table 1, Eq. (4), [12])는 원문 표기 그대로 두세요.
4. 레이아웃 순서:
   - 2단(Two-column) 문서의 경우 실제 읽기 순서(좌측 단 위→아래, 이어서 우측 단 위→아래)를 지켜 번역하세요.

[출력 형식]
반드시 아래 JSON 배열 형식으로만 응답하세요. 각 block_id는 입력으로 주어진 원문 블록과 1:1로 대응해야 합니다. 마크다운 코드 블록 외 불필요한 서문을 붙이지 마세요.
[
  {
    "block_id": "p1_b1",
    "type": "heading | paragraph | caption | equation | list",
    "translated_md": "번역된 마크다운 텍스트 (수식은 $...$ 또는 $$...$$)"
  }
]`;

const SUMMARY_SYSTEM_PROMPT = `당신은 인공지능·머신러닝·컴퓨터 비전 분야의 전문 연구자이자 친절한 튜터입니다.
AI/컴퓨터공학 학부 2학년 전공자가 직관적으로 이해할 수 있도록 논문을 체계적으로 분석하여 Markdown으로 작성하세요.

[핵심 작성 원칙]
1. Intuition First: 난해한 수식이나 아키텍처를 설명하기 전에 일상생활의 비유나 시각적 비유를 먼저 제시하세요.
2. 전문 용어 원문 유지: 기술 용어(예: Self-Attention, Inductive Bias, Covariance)는 영어 원문을 유지하고, 필요 시 괄호 안에 짧은 한글 해설을 병기하세요.
3. 수식 단계별 분해: 모든 수식은 KaTeX($...$, $$...$$)으로 표기하고, 각 기호(Notation)의 차원과 의미를 목록 또는 표로 해체해 설명하세요.

[필수 출력 구조 — summary.md]
# [Paper Review] 논문 제목 (영문 약칭)

> **arXiv / Conference**: 발표 학회 또는 arXiv 정보  
> **Authors**: 저자 목록  
> **Official Code**: 공식 코드 저장소 (있는 경우)

---

## 🚀 3대 핵심 질문 요약
1. **어떤 문제를 해결하고자 하였는가? (Problem)**
2. **어떤 핵심 기술을 사용하여 해결하였는가? (Solution)**
3. **향후 어떤 방향으로 발전되었는가? (Evolution & Impact)**

---

## 1. 📌 논문 개요 & 문제 정의
(연구 배경 · 기존 Baseline 한계 · 핵심 문제 정의)

## 2. ⚙️ 핵심 아이디어 & 방법론
(전체 파이프라인 · 직관적 비유 · 핵심 수식 분해 표 · Baseline 비교 표)

## 3. 📊 실험 설계 및 결과 분석
(평가 환경/데이터셋/지표 · 정량/정성 해석 · Ablation Study)

## 4. 💡 비판적 고찰 & 확장성
(이 논문의 한계점 · 향후 연구 및 후속 발전 방향)

## 🏁 요약 및 핵심 정리
- **핵심 3줄 요약**
- **주목할 점 및 주의사항 (Points to Note)**`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getModelCandidates(preferredModel) {
  const base = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'];
  const list = [];
  if (preferredModel) list.push(preferredModel);
  for (const m of base) {
    if (!list.includes(m)) list.push(m);
  }
  return list;
}

async function callGeminiWithRetry({ apiKey, model, systemPrompt, parts, temperature = 0.2, timeoutMs = 90000 }) {
  if (!apiKey) {
    throw new Error('Gemini API 키가 설정되지 않았습니다. 우측 상단 설정(⚙)에서 API 키를 입력해 주세요.');
  }

  const candidates = getModelCandidates(model);
  let lastErr = null;

  for (const m of candidates) {
    const backoffMs = [0, 1500, 3000];
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      if (backoffMs[attempt] > 0) {
        await sleep(backoffMs[attempt]);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts }],
              generationConfig: { temperature }
            }),
            signal: controller.signal
          }
        );
        clearTimeout(timer);

        if (res.status === 429 || res.status === 503) {
          const errText = await res.text().catch(() => '');
          lastErr = new Error(`API 혼잡/할당량 제한 (${res.status}): ${errText.slice(0, 180)}`);
          continue; // retry with backoff
        }

        const json = await res.json();
        if (!res.ok) {
          const msg = json?.error?.message || `HTTP ${res.status}`;
          lastErr = new Error(`${m}: ${msg}`);
          // Try next model candidate if model is not found / unsupported
          if (res.status === 404 || res.status === 400) break;
          continue;
        }

        const text = (json?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || '')
          .join('')
          .trim();

        if (!text) {
          lastErr = new Error(`${m}: 응답 텍스트가 비어 있습니다.`);
          break;
        }
        return { text, modelUsed: m };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (err.name === 'AbortError') {
          lastErr = new Error(`${m}: 요청 시간 초과`);
          break;
        }
      }
    }
  }

  throw lastErr || new Error('Gemini API 호출에 실패했습니다.');
}

function extractJsonArray(rawText) {
  let cleaned = String(rawText || '').trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('번역 JSON 배열 형식이 올바르지 않습니다.');
  }
  return parsed;
}

async function translatePage({ apiKey, model, paperTitle, page, blocks, pageImageBase64 }) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { translatedBlocks: [], modelUsed: model };
  }

  const inputBlocks = blocks.map((b) => ({
    block_id: b.block_id,
    type: b.type || 'paragraph',
    text: b.text
  }));

  const parts = [];
  if (pageImageBase64) {
    const cleanB64 = pageImageBase64.replace(/^data:image\/\w+;base64,/, '');
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: cleanB64
      }
    });
  }

  parts.push({
    text:
      `논문 제목: ${paperTitle || 'Unknown'}\n` +
      `페이지: ${page}\n` +
      `아래 원문 블록 배열을 각 block_id와 1:1 매칭하여 번역 JSON 배열로 반환하세요.\n\n` +
      JSON.stringify(inputBlocks, null, 2)
  });

  const { text, modelUsed } = await callGeminiWithRetry({
    apiKey,
    model,
    systemPrompt: TRANSLATION_SYSTEM_PROMPT,
    parts,
    temperature: 0.15
  });

  const parsed = extractJsonArray(text);
  const byId = new Map(parsed.map((item) => [item.block_id, item]));

  const normalized = inputBlocks.map((src) => {
    const matched = byId.get(src.block_id);
    return {
      block_id: src.block_id,
      type: matched?.type || src.type,
      translated_md: matched?.translated_md || src.text
    };
  });

  return { translatedBlocks: normalized, modelUsed };
}

async function generatePaperSummary({ apiKey, model, meta, allBlocksText, pdfBuffer }) {
  const parts = [];

  if (pdfBuffer && pdfBuffer.length <= 18 * 1024 * 1024) {
    parts.push({
      inlineData: {
        mimeType: 'application/pdf',
        data: pdfBuffer.toString('base64')
      }
    });
  }

  const promptText =
    `논문 제목: ${meta.title || 'Unknown'}\n` +
    `저자: ${meta.authors || 'Unknown'}\n` +
    `학회/링크: ${meta.venue || ''} ${meta.arxiv_url || ''}\n\n` +
    (allBlocksText
      ? `[추출된 원문 텍스트 발췌]\n${allBlocksText.slice(0, 32000)}\n\n`
      : '') +
    `위 논문을 review-paper 스킬의 필수 출력 구조에 맞춰 완벽하게 한국어로 분석·요약해 주세요.\n` +
    `응답 맨 마지막 줄에 다음 형식의 메타 JSON 주석을 한 줄만 추가하세요(선택): <!--META:{"tags":["#Tag1","#Tag2"],"one_line_summary":"20자 이내 한 줄 요약"}-->`;

  parts.push({ text: promptText });

  const { text, modelUsed } = await callGeminiWithRetry({
    apiKey,
    model,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    parts,
    temperature: 0.3,
    timeoutMs: 120000
  });

  let summaryMd = text;
  const metaUpdates = {};
  const metaMatch = summaryMd.match(/<!--META:(\{[\s\S]*?\})-->\s*$/);
  if (metaMatch) {
    try {
      const parsedMeta = JSON.parse(metaMatch[1]);
      if (Array.isArray(parsedMeta.tags) && parsedMeta.tags.length > 0 && (!meta.tags || meta.tags.length === 0)) {
        metaUpdates.tags = parsedMeta.tags.slice(0, 5);
      }
      if (parsedMeta.one_line_summary && !meta.one_line_summary) {
        metaUpdates.one_line_summary = String(parsedMeta.one_line_summary).slice(0, 40);
      }
    } catch {}
    summaryMd = summaryMd.replace(/<!--META:\{[\s\S]*?\}-->\s*$/, '').trim();
  }

  return { summaryMd, metaUpdates, modelUsed };
}

module.exports = {
  translatePage,
  generatePaperSummary
};
