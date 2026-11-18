const crypto = require('crypto');

const PAGE_W = 612; // US Letter width in pt
const PAGE_H = 792; // US Letter height in pt

function escapePdfText(str) {
  return String(str || '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapTextLines(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxChars) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Generates both a valid multi-page 2-column PDF Buffer and matching
 * normalized [x, y, w, h] blocks so seeded papers align 1:1 on first launch.
 */
function buildStructuredSamplePdf(paperSpec) {
  const pageContents = [];
  const blocksByPage = {};

  for (let pIdx = 0; pIdx < paperSpec.pages.length; pIdx++) {
    const pageNum = pIdx + 1;
    const pSpec = paperSpec.pages[pIdx];
    const ops = [];
    const pageBlocks = [];

    // Subtle white paper background & header rule
    ops.push('0.98 0.98 0.98 rg');
    ops.push(`0 0 ${PAGE_W} ${PAGE_H} re f`);
    ops.push('0.15 0.15 0.15 rg');

    // Page header
    ops.push('BT');
    ops.push('/F1 8 Tf');
    ops.push(`44 ${PAGE_H - 30} Td`);
    ops.push(`(${escapePdfText(paperSpec.shortHeader)}) Tj`);
    ops.push('ET');

    ops.push('BT');
    ops.push('/F1 8 Tf');
    ops.push(`${PAGE_W - 72} ${PAGE_H - 30} Td`);
    ops.push(`(Page ${pageNum}) Tj`);
    ops.push('ET');

    ops.push('0.82 0.82 0.82 RG 0.6 w');
    ops.push(`44 ${PAGE_H - 36} m ${PAGE_W - 44} ${PAGE_H - 36} l S`);
    ops.push('0.12 0.12 0.12 rg');

    let leftY = PAGE_H - 64;
    let rightY = PAGE_H - 64;

    if (pageNum === 1 && paperSpec.title) {
      const titleLines = wrapTextLines(paperSpec.title, 54);
      const topStartY = leftY;
      ops.push('BT');
      ops.push('/F2 15 Tf');
      for (let i = 0; i < titleLines.length; i++) {
        const ly = topStartY - i * 19;
        ops.push(`1 0 0 1 44 ${ly} Tm`);
        ops.push(`(${escapePdfText(titleLines[i])}) Tj`);
      }
      ops.push('ET');

      const authorY = topStartY - titleLines.length * 19 - 6;
      ops.push('0.35 0.35 0.35 rg');
      ops.push('BT /F1 9.5 Tf');
      ops.push(`1 0 0 1 44 ${authorY} Tm`);
      ops.push(`(${escapePdfText(paperSpec.authors)}) Tj`);
      ops.push('ET');
      ops.push('0.12 0.12 0.12 rg');

      const nextY = authorY - 22;
      leftY = nextY;
      rightY = nextY;
    }

    let blockCounter = 0;
    for (const item of pSpec.blocks) {
      blockCounter += 1;
      const blockId = `p${pageNum}_b${blockCounter}`;
      const col = item.col === 'right' ? 'right' : 'left';
      const xStart = col === 'left' ? 44 : 318;
      const colW = 248;
      let curY = col === 'left' ? leftY : rightY;

      if (item.type === 'figure') {
        const figH = 112;
        const figBottom = curY - figH;
        // Draw clean technical diagram box + nodes
        ops.push('0.94 0.94 0.93 rg 0.55 0.55 0.55 RG 0.8 w');
        ops.push(`${xStart + 6} ${figBottom + 24} ${colW - 12} ${figH - 28} re B`);
        ops.push('0.78 0.61 0.52 RG 1.2 w');
        ops.push(`${xStart + 32} ${figBottom + 56} 46 28 re S`);
        ops.push(`${xStart + 102} ${figBottom + 56} 46 28 re S`);
        ops.push(`${xStart + 172} ${figBottom + 56} 46 28 re S`);
        ops.push(`${xStart + 78} ${figBottom + 70} m ${xStart + 102} ${figBottom + 70} l S`);
        ops.push(`${xStart + 148} ${figBottom + 70} m ${xStart + 172} ${figBottom + 70} l S`);
        ops.push('0.18 0.18 0.18 rg');
        ops.push('BT /F2 8 Tf');
        ops.push(`1 0 0 1 ${xStart + 39} ${figBottom + 67} Tm (Input) Tj`);
        ops.push(`1 0 0 1 ${xStart + 109} ${figBottom + 67} Tm (Model) Tj`);
        ops.push(`1 0 0 1 ${xStart + 177} ${figBottom + 67} Tm (Render) Tj`);
        ops.push('ET');

        const capLines = wrapTextLines(item.text, 48);
        ops.push('BT /F1 8.5 Tf');
        for (let i = 0; i < capLines.length; i++) {
          ops.push(`1 0 0 1 ${xStart + 4} ${figBottom + 12 - i * 11} Tm`);
          ops.push(`(${escapePdfText(capLines[i])}) Tj`);
        }
        ops.push('ET');

        const totalH = figH + capLines.length * 11 + 8;
        const yTopNorm = (PAGE_H - (curY + 4)) / PAGE_H;
        const hNorm = totalH / PAGE_H;
        pageBlocks.push({
          block_id: blockId,
          type: 'caption',
          text: item.text,
          bbox: [
            Number((xStart / PAGE_W).toFixed(4)),
            Number(Math.max(0, yTopNorm).toFixed(4)),
            Number((colW / PAGE_W).toFixed(4)),
            Number(Math.min(0.95, hNorm).toFixed(4))
          ]
        });
        curY -= totalH + 10;
      } else if (item.type === 'equation') {
        const eqH = 34;
        ops.push('0.95 0.95 0.95 rg');
        ops.push(`${xStart + 8} ${curY - eqH + 6} ${colW - 16} ${eqH - 4} re f`);
        ops.push('0.12 0.12 0.12 rg');
        ops.push('BT /F2 10 Tf');
        ops.push(`1 0 0 1 ${xStart + 18} ${curY - 16} Tm`);
        ops.push(`(${escapePdfText(item.pdfDisplay || item.text)}) Tj`);
        ops.push('ET');

        const yTopNorm = (PAGE_H - (curY + 4)) / PAGE_H;
        pageBlocks.push({
          block_id: blockId,
          type: 'equation',
          text: item.text,
          bbox: [
            Number((xStart / PAGE_W).toFixed(4)),
            Number(Math.max(0, yTopNorm).toFixed(4)),
            Number((colW / PAGE_W).toFixed(4)),
            Number(((eqH + 4) / PAGE_H).toFixed(4))
          ]
        });
        curY -= eqH + 12;
      } else {
        const isHeading = item.type === 'heading';
        const fontName = isHeading ? '/F2' : '/F1';
        const fontSize = isHeading ? 10.5 : 9.2;
        const lineHeight = isHeading ? 14 : 12.2;
        const maxChars = isHeading ? 40 : 48;
        const lines = wrapTextLines(item.text, maxChars);

        ops.push('BT');
        ops.push(`${fontName} ${fontSize} Tf`);
        for (let i = 0; i < lines.length; i++) {
          ops.push(`1 0 0 1 ${xStart} ${curY - i * lineHeight} Tm`);
          ops.push(`(${escapePdfText(lines[i])}) Tj`);
        }
        ops.push('ET');

        const blockH = Math.max(lineHeight, lines.length * lineHeight) + 4;
        const yTopNorm = (PAGE_H - (curY + fontSize + 2)) / PAGE_H;
        pageBlocks.push({
          block_id: blockId,
          type: item.type || 'paragraph',
          text: item.text,
          bbox: [
            Number(((xStart - 2) / PAGE_W).toFixed(4)),
            Number(Math.max(0, yTopNorm).toFixed(4)),
            Number(((colW + 4) / PAGE_W).toFixed(4)),
            Number((blockH / PAGE_H).toFixed(4))
          ]
        });
        curY -= blockH + (isHeading ? 8 : 11);
      }

      if (col === 'left') {
        leftY = curY;
      } else {
        rightY = curY;
      }
    }

    pageContents.push(ops.join('\n'));
    blocksByPage[String(pageNum)] = pageBlocks;
  }

  // Assemble valid PDF 1.4 binary with exact xref byte offsets
  const objects = [];
  const pageCount = pageContents.length;
  // Obj 1: Catalog, Obj 2: Pages, Obj 3: Font F1, Obj 4: Font F2
  // For each page i: Page obj = 5 + i*2, Content obj = 6 + i*2
  const pageObjNums = [];
  for (let i = 0; i < pageCount; i++) {
    pageObjNums.push(5 + i * 2);
  }

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n`);

  for (let i = 0; i < pageCount; i++) {
    const pObj = 5 + i * 2;
    const cObj = 6 + i * 2;
    const streamStr = pageContents[i];
    const streamLen = Buffer.byteLength(streamStr, 'latin1');
    objects.push(
      `${pObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cObj} 0 R >>\nendobj\n`
    );
    objects.push(
      `${cObj} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamStr}\nendstream\nendobj\n`
    );
  }

  const chunks = [];
  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  chunks.push(Buffer.from(header, 'latin1'));
  let byteOffset = chunks[0].length;
  const offsets = [0];

  for (const objStr of objects) {
    offsets.push(byteOffset);
    const buf = Buffer.from(objStr, 'latin1');
    chunks.push(buf);
    byteOffset += buf.length;
  }

  const xrefOffset = byteOffset;
  let xrefStr = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xrefStr += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailerStr = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefStr + trailerStr, 'latin1'));

  return {
    pdfBuffer: Buffer.concat(chunks),
    blocksByPage
  };
}

function makeHash(seedKey) {
  return crypto.createHash('sha256').update(seedKey).digest('hex').slice(0, 16);
}

function getDemoPapersData() {
  const now = Date.now();

  // 1. 3D Gaussian Splatting (12 pages, body_end_page: 9, Read 5/9p, Reading)
  const gsPages = [];
  for (let p = 1; p <= 12; p++) {
    if (p === 1) {
      gsPages.push({
        blocks: [
          {
            col: 'left',
            type: 'heading',
            text: 'Abstract',
            translated_md: '### 초록 (Abstract)'
          },
          {
            col: 'left',
            type: 'paragraph',
            text: 'Radiance Field methods have revolutionized novel-view synthesis of scenes captured with multiple photos or videos. However, achieving high visual quality still requires neural networks that are costly to train and render. We introduce 3D Gaussian Splatting, which enables real-time 1080p rendering at 30+ fps while matching or exceeding state-of-the-art visual quality.',
            translated_md: 'Radiance Field 기법은 다수의 사진이나 영상으로 촬영된 장면의 Novel-view Synthesis를 혁신했습니다. 그러나 높은 시각적 품질을 달성하려면 여전히 학습과 렌더링 비용이 큰 신경망이 필요합니다. 본 논문은 최신 수준의 화질을 유지하거나 능가하면서도 1080p 해상도에서 30fps 이상의 실시간 렌더링을 가능하게 하는 **3D Gaussian Splatting**을 제안합니다.'
          },
          {
            col: 'right',
            type: 'heading',
            text: '1. Introduction',
            translated_md: '### 1. 서론 (Introduction)'
          },
          {
            col: 'right',
            type: 'paragraph',
            text: 'Unlike volumetric ray-marching in NeRF, our explicit 3D Gaussian representation combines differentiable optimization with a fast visibility-aware tile rasterizer. Starting from sparse Structure-from-Motion points, adaptive density control clones and splits Gaussians across empty and over-reconstructed regions.',
            translated_md: 'NeRF의 볼류메트릭 Ray-marching과 달리, 우리가 제안하는 명시적 3D Gaussian 표현은 미분 가능한 최적화와 빠른 가시성 인식 Tile Rasterizer를 결합합니다. 희소한 Structure-from-Motion(SfM) 포인트에서 시작해 Adaptive Density Control이 빈 영역과 과도하게 복원된 영역에 걸쳐 Gaussian을 복제 및 분할합니다.'
          }
        ]
      });
    } else if (p === 4) {
      gsPages.push({
        blocks: [
          {
            col: 'left',
            type: 'heading',
            text: '3. Differentiable 3D Gaussian Splatting',
            translated_md: '### 3. 미분 가능한 3D Gaussian Splatting'
          },
          {
            col: 'left',
            type: 'paragraph',
            text: 'We represent the scene using a collection of anisotropic 3D Gaussians defined by a full 3D covariance matrix Sigma in world space centered at point mu. Each Gaussian is also associated with an opacity alpha and spherical harmonics coefficients for view-dependent color.',
            translated_md: '우리는 월드 공간의 중심점 $\\mu$를 기준으로 전체 3D 공분산 행렬 $\\Sigma$(Covariance Matrix)로 정의되는 이방성(anisotropic) 3D Gaussian들의 집합으로 장면을 표현합니다. 각 Gaussian은 불투명도 $\\alpha$와 시점 의존적 색상을 위한 Spherical Harmonics 계수도 함께 가집니다.'
          },
          {
            col: 'left',
            type: 'equation',
            text: '$$G(x) = \\exp\\left(-\\frac{1}{2}(x)^T \\Sigma^{-1} (x)\\right)$$',
            pdfDisplay: 'G(x) = exp( -1/2 * x^T * Sigma^(-1) * x )',
            translated_md: '$$G(x) = \\exp\\left(-\\frac{1}{2}(x)^T \\Sigma^{-1} (x)\\right)$$'
          },
          {
            col: 'right',
            type: 'figure',
            text: 'Fig. 2. Overview of our optimization pipeline: SfM points initialize 3D Gaussians, which are projected to 2D tiles and updated via adaptive density control.',
            translated_md: '**Fig. 2.** 최적화 Pipeline 개요: SfM 포인트가 3D Gaussian을 초기화하고, 2D 타일로 투영된 뒤 Adaptive Density Control을 통해 업데이트됩니다.'
          },
          {
            col: 'right',
            type: 'paragraph',
            text: 'Directly optimizing a 3D covariance matrix Sigma via gradient descent is non-trivial because covariance matrices have physical meaning only when they are positive semi-definite. Instead, we decompose Sigma into a scaling matrix S and a rotation matrix R parameterized by a unit quaternion q.',
            translated_md: '경사 하강법(Gradient Descent)으로 3D 공분산 행렬 $\\Sigma$를 직접 최적화하는 것은 쉽지 않은데, 공분산 행렬은 **양의 준정부호(Positive Semi-Definite)**일 때만 물리적 의미를 갖기 때문입니다. 이를 해결하기 위해 우리는 $\\Sigma$를 스케일링 행렬 $S$와 단위 쿼터니언 $q$로 매개변수화된 회전 행렬 $R$로 분해합니다.'
          },
          {
            col: 'right',
            type: 'equation',
            text: '$$\\Sigma = R S S^T R^T$$',
            pdfDisplay: 'Sigma = R * S * S^T * R^T',
            translated_md: '$$\\Sigma = R S S^T R^T$$'
          }
        ]
      });
    } else if (p >= 10) {
      gsPages.push({
        blocks: [
          {
            col: 'left',
            type: 'heading',
            text: p === 10 ? 'References' : `References (cont. p.${p})`,
            translated_md: `### 참고문헌 (References - p.${p})`
          },
          {
            col: 'left',
            type: 'paragraph',
            text: '[1] Mildenhall et al., NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis, ECCV 2020. [2] Zwicker et al., EWA Volume Splatting, IEEE Visualization 2001.',
            translated_md: '[1] Mildenhall et al., NeRF: View Synthesis를 위한 신경 방사장 표현, ECCV 2020. [2] Zwicker et al., EWA Volume Splatting, IEEE Visualization 2001.'
          }
        ]
      });
    } else {
      gsPages.push({
        blocks: [
          {
            col: 'left',
            type: 'heading',
            text: `Section ${p}. Optimization & Tile Rasterization`,
            translated_md: `### ${p}. 최적화 및 타일 기반 래스터화`
          },
          {
            col: 'left',
            type: 'paragraph',
            text: `On page ${p}, we detail the fast tile-based rasterizer that splits the screen into 16x16 tiles and sorts Gaussians by depth using radix sort for alpha blending.`,
            translated_md: `${p}페이지에서는 화면을 $16 \\times 16$ 타일로 분할하고 Radix Sort로 Gaussian을 깊이 순 정렬하여 Alpha Blending을 수행하는 고속 Tile Rasterizer를 설명합니다.`
          },
          {
            col: 'right',
            type: 'paragraph',
            text: `Loss computation combines an L1 photometric error with a D-SSIM structural term under Adam optimization: L = (1 - lambda) L1 + lambda L_D-SSIM.`,
            translated_md: `손실 함수(Loss Function)는 Adam 최적화 하에서 L1 광도 오차와 D-SSIM 구조적 항을 결합합니다: $\\mathcal{L} = (1 - \\lambda)\\mathcal{L}_1 + \\lambda\\mathcal{L}_{\\text{D-SSIM}}$.`
          }
        ]
      });
    }
  }

  // 2. Depth Anything V2 (14 pages, body_end_page: 10, Done)
  const depthPages = [];
  for (let p = 1; p <= 14; p++) {
    depthPages.push({
      blocks: [
        {
          col: 'left',
          type: 'heading',
          text: p === 1 ? '1. Introduction' : p >= 11 ? 'References' : `Section ${p}. Synthetic Teacher Distillation`,
          translated_md: p === 1 ? '### 1. 서론' : p >= 11 ? `### 참고문헌 (p.${p})` : `### ${p}. 합성 데이터 Teacher-Student 증류`
        },
        {
          col: 'left',
          type: 'paragraph',
          text: p === 1
            ? 'Monocular depth estimation foundation models often suffer from noisy real-world depth labels and slow inference. Depth Anything V2 replaces all labeled real images with synthetic images to train a DINOv2-G teacher, distilling fine structural edges into lightweight student models.'
            : `Page ${p} analyzes gradient matching losses and pseudo-label filtering across large-scale unlabeled outdoor and indoor scenes.`,
          translated_md: p === 1
            ? '단안 깊이 추정(Monocular Depth Estimation) Foundation Model은 노이즈가 많은 실제 깊이 라벨과 느린 추론 속도로 어려움을 겪습니다. **Depth Anything V2**는 라벨링된 실제 이미지를 모두 합성 이미지로 대체하여 DINOv2-G Teacher를 학습하고, 정밀한 경계 구조를 경량 Student 모델로 증류합니다.'
            : `${p}페이지에서는 대규모 비라벨 실외·실내 장면에 대한 Gradient Matching Loss와 Pseudo-label 필터링을 분석합니다.`
        },
        {
          col: 'right',
          type: 'equation',
          text: '$$\\mathcal{L}_{\\text{grad}} = \\frac{1}{HW} \\sum_{i,j} |\\nabla d_i - \\nabla \\hat{d}_i|$$',
          pdfDisplay: 'L_grad = (1/HW) * sum |grad(d) - grad(d_hat)|',
          translated_md: '$$\\mathcal{L}_{\\text{grad}} = \\frac{1}{HW} \\sum_{i,j} |\\nabla d_i - \\nabla \\hat{d}_i|$$'
        }
      ]
    });
  }

  // 3. PhysGS Bench (9 pages, body_end_page: 9, Done)
  const physPages = [];
  for (let p = 1; p <= 9; p++) {
    physPages.push({
      blocks: [
        {
          col: 'left',
          type: 'heading',
          text: p === 1 ? '1. Motivation & Benchmark Design' : `Section ${p}. Optical & Material Consistency`,
          translated_md: p === 1 ? '### 1. 연구 동기 및 벤치마크 설계' : `### ${p}. 광학 및 재질 일관성 평가`
        },
        {
          col: 'left',
          type: 'paragraph',
          text: p === 1
            ? 'While 3D Gaussian Splatting excels at appearance reconstruction, physically plausible relighting and refractive optics remain under-evaluated. PhysGS Bench introduces controlled BRDF, specular highlights, and dynamic deformation metrics.'
            : `Page ${p} evaluates physically based rendering accuracy across specular, translucent, and anisotropic surfaces.`,
          translated_md: p === 1
            ? '3D Gaussian Splatting은 외관 복원에는 탁월하지만, 물리적으로 타당한 Relighting과 굴절 광학(Refractive Optics) 평가는 부족했습니다. **PhysGS Bench**는 통제된 BRDF, 정반사 하이라이트, 동적 변형 평가지표를 도입합니다.'
            : `${p}페이지에서는 정반사(specular), 반투명, 이방성 표면에 대한 물리 기반 렌더링 정확도를 평가합니다.`
        },
        {
          col: 'right',
          type: 'equation',
          text: '$$L_o(\\omega_o) = \\int_{\\Omega} f_r(\\omega_i, \\omega_o) L_i(\\omega_i) (n \\cdot \\omega_i) d\\omega_i$$',
          pdfDisplay: 'L_o(w_o) = integral f_r(w_i, w_o) L_i(w_i) (n . w_i) dw_i',
          translated_md: '$$L_o(\\omega_o) = \\int_{\\Omega} f_r(\\omega_i, \\omega_o) L_i(\\omega_i) (n \\cdot \\omega_i) d\\omega_i$$'
        }
      ]
    });
  }

  const specs = [
    {
      seedKey: 'demo-3d-gaussian-splatting-2023',
      title: '3D Gaussian Splatting for Real-Time Radiance Field Rendering',
      shortTitle: '3D Gaussian Splatting',
      shortHeader: 'Kerbl et al. | ACM TOG (SIGGRAPH 2023)',
      authors: 'Bernhard Kerbl, Georgios Kopanas, Thomas Leimkuhler, George Drettakis',
      venue: 'ACM Transactions on Graphics (SIGGRAPH 2023)',
      arxiv_url: 'https://arxiv.org/abs/2308.04079',
      code_url: 'https://github.com/graphdeco-inria/gaussian-splatting',
      tags: ['#3DGS', '#Graphics', '#Rendering'],
      one_line_summary: '실시간 3D 가우시안 스플래팅 기반 고화질 렌더링',
      review: '명시적 3D 가우시안과 타일 래스터화로 1080p 실시간 렌더링을 달성한 핵심 논문.',
      body_end_page: 9,
      last_page: 4,
      read_pages: [1, 2, 3, 4, 5],
      status: 'Reading',
      updated_at: now - 1000 * 60 * 10,
      pages: gsPages,
      preTranslatedPages: [1, 2, 3, 4, 5],
      annotations: {
        highlights: [
          {
            id: 'hl-gs-1',
            page: 4,
            block_id: 'p4_b5',
            target: 'original',
            text: 'Directly optimizing a 3D covariance matrix Sigma via gradient descent is non-trivial because covariance matrices have physical meaning only when they are positive semi-definite.',
            rects: [[0.5196, 0.245, 0.405, 0.052]],
            color: 'amber',
            note: '공분산 행렬의 양의 준정부호(PSD) 제약 때문!',
            created_at: now - 1000 * 60 * 15
          }
        ],
        bookmarks: [
          { id: 'bm-gs-1', page: 1, label: 'Abstract & Intro', created_at: now - 1000 * 60 * 30 },
          { id: 'bm-gs-2', page: 4, label: 'Covariance S & R 분해', created_at: now - 1000 * 60 * 14 }
        ],
        comments: [
          {
            id: 'cm-gs-1',
            page: 4,
            block_id: 'p4_b5',
            original_excerpt: 'Directly optimizing a 3D covariance matrix Sigma via gradient descent is non-trivial because covariance matrices have physical meaning only when they are positive semi-definite. Instead, we decompose Sigma into a scaling matrix S and a rotation matrix R parameterized by a unit quaternion q.',
            translated_excerpt: '경사 하강법으로 3D 공분산 행렬 $\\Sigma$를 직접 최적화하는 것은 쉽지 않은데, 공분산 행렬은 양의 준정부호(Positive Semi-Definite)일 때만 물리적 의미를 갖기 때문입니다. 이를 해결하기 위해 $\\Sigma$를 스케일링 행렬 $S$와 회전 행렬 $R$로 분해합니다.',
            question: '왜 공분산 행렬 Sigma를 직접 경사 하강법으로 최적화하지 않고 Scaling S와 Rotation R로 분해하나요? R과 S로 분해하면 어떤 수학적 이점이 생기나요?',
            resolved: false,
            created_at: now - 1000 * 60 * 12
          }
        ]
      },
      summary_md: `# [Paper Review] 3D Gaussian Splatting for Real-Time Radiance Field Rendering (3DGS)

> **arXiv / Conference**: [arXiv:2308.04079](https://arxiv.org/abs/2308.04079) · SIGGRAPH 2023 (ACM TOG)  
> **Authors**: Bernhard Kerbl, Georgios Kopanas, Thomas Leimkühler, George Drettakis  
> **Official Code**: [graphdeco-inria/gaussian-splatting](https://github.com/graphdeco-inria/gaussian-splatting)

---

## 🚀 3대 핵심 질문 요약

1. **어떤 문제를 해결하고자 하였는가? (Problem)**  
   기존 NeRF 계열 모델은 사실적인 새로운 시점(Novel-view)을 생성하지만, 광선(Ray)마다 신경망을 수백 번씩 통과해야 해 학습과 렌더링 속도가 너무 느려 1080p 실시간 렌더링이 불가능했습니다.
2. **어떤 핵심 기술을 사용하여 해결하였는가? (Solution)**  
   장면을 수많은 반투명 **3D 타원체(Gaussian)**들로 직접 표현하고, 미분 가능한 **타일 기반 고속 래스터화(Tile-based Rasterization)**와 **Adaptive Density Control**을 도입하여 신경망 추론 없이도 초고속 학습·렌더링을 달성했습니다.
3. **향후 어떤 방향으로 발전되었는가? (Evolution & Impact)**  
   4D 동적 장면(Dynamic 3DGS), SLAM, 물리 시뮬레이션(PhysGaussian), 생성형 3D(DreamGaussian) 등 3D Vision·Graphics 전반의 표준 기반 표현으로 자리 잡았습니다.

---

## 1. 📌 논문 개요 & 문제 정의

* **연구 배경**: NeRF(2020)와 Mip-NeRF360은 최고 수준의 화질을 보였지만 볼륨 레이 마칭(Volumetric Ray-marching) 연산 병목으로 실시간(30+ fps) 달성이 어려웠습니다.
* **기존 접근의 한계**: Instant-NGP 등 해시 그리드 기반 가속도 여전히 Ray 샘플링에 의존해 고해상도 1080p 뷰에서 프레임 드랍이 발생합니다.
* **핵심 문제**: *“신경망 없이도 미분 가능하게 최적화되며, GPU 래스터화 파이프라인을 그대로 타는 명시적(Explicit) 3D 장면 표현을 만들 수 있을까?”*

---

## 2. ⚙️ 핵심 아이디어 & 방법론

* **직관적 비유 (Intuitive Analogy)**:  
  공간을 촘촘한 모래시계 격자로 채우고 빛을 쏘며 일일이 묻는 것(NeRF) 대신, 공중에 반투명한 색색의 럭비공(3D Gaussian) 수십만 개를 띄워 놓고 카메라 방향으로 한꺼번에 도장을 찍어(Splatting) 겹쳐 그리는 방식입니다.
* **핵심 수식 분해 (Mathematical Breakdown)**:

$$\\Sigma = R S S^T R^T$$

| 기호 (Notation) | 차원 | 직관적 의미 |
| :--- | :--- | :--- |
| $\\Sigma$ | $3 \\times 3$ | 3D 타원체의 방향과 퍼짐 정도를 나타내는 **공분산 행렬(Covariance)** |
| $S$ | $3 \\times 3$ | x, y, z 축 방향의 길이를 늘리고 줄이는 **Scaling 대각 행렬** |
| $R$ | $3 \\times 3$ | 단위 쿼터니언 $q \\in \\mathbb{R}^4$로 만든 **Rotation 회전 행렬** |

* **왜 분해하는가?**: 경사 하강법 중 $\\Sigma$ 원소를 직접 업데이트하면 양의 준정부호(PSD) 조건이 깨져 타원체가 음수 부피로 붕괴할 수 있습니다. 반면 $R S S^T R^T$ 형태로 묶어두면 어떤 $S, q$ 값에서도 항상 유효한 공분산 행렬이 보장됩니다.

---

## 3. 📊 실험 설계 및 결과 분석

* **평가 환경**: Mip-NeRF360, Tanks and Temples, Deep Blending 데이터셋 (PSNR, SSIM, LPIPS, FPS).
* **성과**: Mip-NeRF360과 동등 이상의 PSNR을 유지하면서도 **1080p 해상도에서 100+ FPS** 달성.
* **Ablation Study**: Spherical Harmonics, Anisotropic Covariance, Adaptive Density Control(Clone & Split) 중 하나라도 제거하면 경계선 선명도와 PSNR이 크게 하락함을 입증했습니다.

---

## 4. 💡 비판적 고찰 & 확장성

* **한계점**: 수많은 Gaussian 저장으로 메모리/VRAM 사용량이 크며(수백 MB), 3D 기하 표면(Mesh) 추출 및 물리적 재조명(Relighting)에는 별도 정규화가 필요합니다.
* **후속 발전**: 2D Gaussian Splatting(표면 복원 강화), PhysGaussian(물리 변형), 4D Gaussian Splatting(동적 영상).

---

## 🏁 요약 및 핵심 정리

* **핵심 3줄 요약**:
  1. 신경망 레이 마칭 대신 명시적 **3D Gaussian** 집합으로 장면을 표현했습니다.
  2. 공분산을 $\\Sigma = R S S^T R^T$로 분해하고 **16x16 타일 래스터화**로 1080p 실시간 렌더링을 실현했습니다.
  3. SfM 포인트에서 시작해 빈 곳은 채우고 큰 곳은 쪼개는 **Adaptive Density Control**로 고화질을 얻었습니다.
* **주목할 점 (Points to Note)**:  
  수식에서 $\\alpha$-blending은 가시성 정렬 순서가 정확해야 하므로, 매 프레임 Radix Sort로 깊이 정렬을 수행하는 점이 핵심 속도·품질 비결입니다.
`
    },
    {
      seedKey: 'demo-depth-anything-v2-2024',
      title: 'Depth Anything V2',
      shortTitle: 'Depth Anything V2',
      shortHeader: 'Yang et al. | NeurIPS 2024',
      authors: 'Lihe Yang, Bingyi Kang, Zilong Huang, Zhen Zhao, Xiaogang Xu, Jiashi Feng, Hengshuang Zhao',
      venue: 'NeurIPS 2024',
      arxiv_url: 'https://arxiv.org/abs/2406.09414',
      code_url: 'https://github.com/DepthAnything/Depth-Anything-V2',
      tags: ['#Depth', '#Vision', '#Foundation'],
      one_line_summary: '합성 데이터 교사 증류 기반 초정밀 단안 깊이 추정',
      review: '합성 이미지의 깨끗한 깊이 라벨과 DINOv2-G Teacher 증류로 실세계 디테일과 속도를 모두 잡은 논문.',
      body_end_page: 10,
      last_page: 10,
      read_pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      status: 'Done',
      updated_at: now - 1000 * 60 * 120,
      pages: depthPages,
      preTranslatedPages: [1, 2, 3, 4],
      annotations: {
        highlights: [
          {
            id: 'hl-depth-1',
            page: 1,
            block_id: 'p1_b2',
            target: 'original',
            text: 'Depth Anything V2 replaces all labeled real images with synthetic images to train a DINOv2-G teacher.',
            rects: [[0.071, 0.19, 0.405, 0.045]],
            color: 'amber',
            note: '실제 라벨 노이즈 제거 전략',
            created_at: now - 1000 * 60 * 130
          }
        ],
        bookmarks: [
          { id: 'bm-depth-1', page: 1, label: 'Synthetic Teacher 핵심 아이디어', created_at: now - 1000 * 60 * 135 }
        ],
        comments: [
          {
            id: 'cm-depth-1',
            page: 1,
            block_id: 'p1_b2',
            original_excerpt: 'Depth Anything V2 replaces all labeled real images with synthetic images to train a DINOv2-G teacher, distilling fine structural edges into lightweight student models.',
            translated_excerpt: 'Depth Anything V2는 라벨링된 실제 이미지를 모두 합성 이미지로 대체하여 DINOv2-G Teacher를 학습하고, 정밀한 경계 구조를 경량 Student 모델로 증류합니다.',
            question: '합성 데이터로만 Teacher를 학습하면 실제 세계(Real-world)와의 도메인 갭이 발생하지 않나요? Pseudo-label 증류가 이 갭을 어떻게 해소하나요?',
            resolved: false,
            created_at: now - 1000 * 60 * 125
          }
        ]
      },
      summary_md: `# [Paper Review] Depth Anything V2

> **arXiv / Conference**: [arXiv:2406.09414](https://arxiv.org/abs/2406.09414) · NeurIPS 2024  
> **Authors**: Lihe Yang, Bingyi Kang, et al.  
> **Official Code**: [DepthAnything/Depth-Anything-V2](https://github.com/DepthAnything/Depth-Anything-V2)

---

## 🚀 3대 핵심 질문 요약

1. **어떤 문제를 해결하고자 하였는가? (Problem)**  
   실제 센서(LiDAR, 스테레오)로 수집한 깊이 데이터셋은 머리카락, 투명 유리, 가는 구조물 주변에 노이즈와 결측치가 많아 모델의 세밀한 경계선 복원을 방해했습니다.
2. **어떤 핵심 기술을 사용하여 해결하였는가? (Solution)**  
   모든 라벨링된 실제 데이터를 버리고 **정확한 합성(Synthetic) 데이터**로만 거대 DINOv2-G Teacher를 학습한 뒤, 6,200만 장의 비라벨 실제 이미지에 **Pseudo-label**을 생성해 경량 Student 모델로 증류했습니다.
3. **향후 어떤 방향으로 발전되었는가? (Evolution & Impact)**  
   단안 깊이 추정과 Metric Depth, 로보틱스·자율주행·3D 복원 파이프라인의 사실상 표준 사전학습 백본이 되었습니다.

---

## 1. 📌 논문 개요 & 문제 정의
* 실제 깊이 센서는 반사/투명 물체에서 측정이 깨지지만, 게임/렌더링 엔진 기반 합성 데이터는 픽셀 단위 Ground Truth가 100% 정확합니다.

## 2. ⚙️ 핵심 아이디어 & 방법론
* **직관적 비유**: 흐릿한 참고서(실제 센서 라벨) 대신 완벽히 인쇄된 정답지(합성 데이터)로 1등 과외 선생님(DINOv2-G)을 키운 뒤, 수천만 장의 실전 문제집(비라벨 실세계 사진)을 풀게 해 제자(Student)에게 전수하는 방식입니다.
* **수식**: Gradient Matching Loss $\\mathcal{L}_{\\text{grad}}$를 통해 얇은 객체 경계의 급격한 깊이 변화를 정밀하게 보존합니다.

## 3. 📊 실험 설계 및 결과 분석
* V1 대비 10배 빠른 추론 속도를 내면서도 투명 물체, 얇은 전선, 반사 표면에서 월등히 선명한 깊이 맵을 생성합니다.

## 4. 💡 비판적 고찰 & 확장성
* 상대 깊이(Relative Depth) 중심이므로 절대 스케일이 필요할 때는 Metric Depth 파인튜닝이 필요합니다.

## 🏁 요약 및 핵심 정리
* **핵심 3줄 요약**: 합성 데이터 Teacher + 대규모 비라벨 실사 Pseudo-labeling + 경량 Student 증류로 속도와 정밀도를 동시 달성했습니다.
`
    },
    {
      seedKey: 'demo-physgs-bench-2025',
      title: 'PhysGS Bench: Benchmarking Physics & Optics in 3D Gaussian Splatting',
      shortTitle: 'PhysGS Bench',
      shortHeader: 'PhysGS Authors | CVPR Benchmark Track',
      authors: 'PhysGS Benchmark Consortium',
      venue: 'CVPR Benchmark Track',
      arxiv_url: 'https://arxiv.org/abs/2501.00001',
      code_url: '',
      tags: ['#3DGS', '#Optics', '#Benchmark'],
      one_line_summary: '물리 기반 3DGS 광학·재질 렌더링 벤치마크',
      review: '정반사, 굴절, 동적 변형을 포함한 물리 타당성 평가 지표와 통제 데이터셋을 제시.',
      body_end_page: 9,
      last_page: 9,
      read_pages: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      status: 'Done',
      updated_at: now - 1000 * 60 * 300,
      pages: physPages,
      preTranslatedPages: [1, 2, 3],
      annotations: {
        highlights: [
          {
            id: 'hl-phys-1',
            page: 1,
            block_id: 'p1_b2',
            target: 'original',
            text: 'PhysGS Bench introduces controlled BRDF, specular highlights, and dynamic deformation metrics.',
            rects: [[0.071, 0.20, 0.405, 0.04]],
            color: 'amber',
            note: 'BRDF 및 정반사 평가 항목',
            created_at: now - 1000 * 60 * 310
          }
        ],
        bookmarks: [
          { id: 'bm-phys-1', page: 1, label: 'BRDF 렌더링 방정식', created_at: now - 1000 * 60 * 320 }
        ],
        comments: [
          {
            id: 'cm-phys-1',
            page: 1,
            block_id: 'p1_b3',
            original_excerpt: 'L_o(w_o) = integral f_r(w_i, w_o) L_i(w_i) (n . w_i) dw_i',
            translated_excerpt: '$$L_o(\\omega_o) = \\int_{\\Omega} f_r(\\omega_i, \\omega_o) L_i(\\omega_i) (n \\cdot \\omega_i) d\\omega_i$$',
            question: '3D Gaussian Splatting처럼 표면 법선(normal)이 명시적이지 않은 표현에서 BRDF 항 $f_r(\\omega_i, \\omega_o)$를 어떻게 안정적으로 추정하나요?',
            resolved: false,
            created_at: now - 1000 * 60 * 305
          }
        ]
      },
      summary_md: `# [Paper Review] PhysGS Bench

> **arXiv / Conference**: CVPR Benchmark Track  
> **Authors**: PhysGS Benchmark Consortium

---

## 🚀 3대 핵심 질문 요약
1. **Problem**: 기존 3DGS 평가는 고정 조명 PSNR에만 치중해 물리적 재조명과 광학 일관성을 검증하지 못했습니다.
2. **Solution**: 통제된 BRDF 재질, 정반사·투명 굴절, 물리 변형 시나리오를 포함한 표준 벤치마크를 제안했습니다.
3. **Evolution & Impact**: Relightable 3DGS와 물리 결합 디지털 트윈 연구의 비교 기준으로 활용됩니다.

## 1. 📌 논문 개요 & 문제 정의
* 외관 암기(View interpolation)가 아닌 **물리 법칙(Rendering Equation)** 준수 여부를 검증합니다.

## 2. ⚙️ 핵심 아이디어 & 방법론
* Rendering Equation: $L_o(\\omega_o) = \\int_{\\Omega} f_r(\\omega_i, \\omega_o) L_i(\\omega_i) (n \\cdot \\omega_i) d\\omega_i$ 기반으로 Normal Consistency, Albedo Error, Specular PSNR을 분리 측정합니다.

## 3. 📊 실험 설계 및 결과 분석
* 표준 3DGS는 Specular 반사가 큰 금속/유리 객체에서 법선 오차가 급증함을 정량 입증했습니다.

## 4. 💡 비판적 고찰 & 확장성
* 합성 통제 씬과 실측 라이트 스테이지 씬을 병행해 실용성을 높였습니다.

## 🏁 요약 및 핵심 정리
* **핵심 3줄 요약**: 3DGS의 물리·광학 일반화 성능을 평가하기 위한 BRDF/Relighting 통합 벤치마크입니다.
`
    }
  ];

  return specs.map((spec) => {
    const pdfHash = makeHash(spec.seedKey);
    const { pdfBuffer, blocksByPage } = buildStructuredSamplePdf(spec);
    const translations = {};
    for (const pNum of spec.preTranslatedPages) {
      const pBlocks = spec.pages[pNum - 1].blocks;
      const pdfBlocks = blocksByPage[String(pNum)] || [];
      translations[String(pNum)] = pBlocks.map((b, idx) => ({
        block_id: pdfBlocks[idx]?.block_id || `p${pNum}_b${idx + 1}`,
        type: b.type === 'figure' ? 'caption' : b.type,
        translated_md: b.translated_md
      }));
    }

    // Align seeded original highlights exactly to their generated block bbox
    for (const hl of spec.annotations?.highlights || []) {
      if (hl.target === 'original' && hl.page && hl.block_id) {
        const blk = (blocksByPage[String(hl.page)] || []).find((b) => b.block_id === hl.block_id);
        if (blk && Array.isArray(blk.bbox)) {
          const [bx, by, bw, bh] = blk.bbox;
          hl.rects = [[bx, by, bw, Number((bh * 0.45).toFixed(4))]];
        }
      }
    }

    const meta = {
      pdf_hash: pdfHash,
      title: spec.title,
      short_title: spec.shortTitle,
      authors: spec.authors,
      year: spec.venue.match(/\d{4}/)?.[0] || '2024',
      venue: spec.venue,
      arxiv_url: spec.arxiv_url,
      code_url: spec.code_url,
      tags: spec.tags,
      one_line_summary: spec.one_line_summary,
      review: spec.review,
      total_pages: spec.pages.length,
      body_end_page: spec.body_end_page,
      last_page: spec.last_page,
      read_pages: spec.read_pages,
      status: spec.status,
      created_at: spec.updated_at - 1000 * 60 * 60,
      updated_at: spec.updated_at
    };

    return {
      pdfHash,
      meta,
      blocks: blocksByPage,
      translations,
      annotations: spec.annotations,
      summary_md: spec.summary_md,
      pdfBuffer
    };
  });
}

module.exports = {
  getDemoPapersData
};
