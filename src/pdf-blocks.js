(function () {
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function round4(v) {
    return Number(v.toFixed(4));
  }

  function inferBlockType(text, fontSize, medianFont) {
    const t = text.trim();
    if (!t) return 'paragraph';
    if (/^(Fig\.?|Figure|Table|Algorithm)\s*\d+/i.test(t)) return 'caption';
    if (/^(\[?\d+\]?|•|-|\*)\s+/.test(t) && t.length < 220) return 'list';
    if (
      (fontSize >= medianFont * 1.12 && t.length < 110) ||
      (/^(Abstract|Introduction|Related Work|Method|Methodology|Experiments?|Results?|Conclusion|References|Bibliography|\d+\.(\d+\.)?\s+[A-Z])/.test(t) && t.length < 95)
    ) {
      return 'heading';
    }
    if (
      t.length < 160 &&
      (/[=∑∫∏≈≠≤≥∈∀∃∇∂λσαμπθ]/.test(t) || /\(\d+(\.\d+)?\)\s*$/.test(t)) &&
      !/[.!?]\s+[A-Z]/.test(t)
    ) {
      return 'equation';
    }
    return 'paragraph';
  }

  function mergeItemsIntoLines(items, viewport) {
    const vpW = viewport.width || 612;
    const vpH = viewport.height || 792;
    const raw = [];

    for (const item of items) {
      const str = String(item.str || '');
      if (!str.trim()) continue;
      const tr = item.transform || [1, 0, 0, 1, 0, 0];
      const fontSize = Math.max(6, Math.hypot(tr[2], tr[3]) || item.height || 10);
      const xPdf = tr[4];
      const yBaselinePdf = tr[5];
      const wPdf = Math.max(2, item.width || str.length * fontSize * 0.45);
      const hPdf = Math.max(fontSize, item.height || fontSize);

      // Convert PDF bottom-left baseline to top-left normalized [0..1]
      const xNorm = clamp01(xPdf / vpW);
      const yBottomNorm = clamp01(1 - yBaselinePdf / vpH);
      const hNorm = clamp01(hPdf / vpH);
      const yTopNorm = clamp01(yBottomNorm - hNorm * 0.88);
      const wNorm = clamp01(wPdf / vpW);

      raw.push({
        str,
        x: xNorm,
        y: yTopNorm,
        w: wNorm,
        h: hNorm,
        fontSize,
        hasEOL: Boolean(item.hasEOL)
      });
    }

    if (raw.length === 0) return [];

    // Group items with nearly equal y into lines
    raw.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of raw) {
      const yTol = Math.max(0.004, it.h * 0.55);
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= yTol) {
        last.items.push(it);
        last.minX = Math.min(last.minX, it.x);
        last.maxX = Math.max(last.maxX, it.x + it.w);
        last.y = Math.min(last.y, it.y);
        last.maxY = Math.max(last.maxY, it.y + it.h);
        last.fontSum += it.fontSize;
      } else {
        lines.push({
          items: [it],
          minX: it.x,
          maxX: it.x + it.w,
          y: it.y,
          maxY: it.y + it.h,
          fontSum: it.fontSize
        });
      }
    }

    return lines
      .map((ln) => {
        ln.items.sort((a, b) => a.x - b.x);
        let text = '';
        let prevEnd = null;
        for (const it of ln.items) {
          if (prevEnd !== null && it.x - prevEnd > 0.004 && !text.endsWith(' ') && !it.str.startsWith(' ')) {
            text += ' ';
          }
          text += it.str;
          prevEnd = it.x + it.w;
        }
        return {
          text: text.replace(/\s+/g, ' ').trim(),
          x: ln.minX,
          y: ln.y,
          w: Math.max(0.01, ln.maxX - ln.minX),
          h: Math.max(0.008, ln.maxY - ln.y),
          fontSize: ln.fontSum / ln.items.length
        };
      })
      .filter((ln) => ln.text && ln.text.length > 0);
  }

  function splitTwoColumns(lines) {
    // Skip very small page header/footer noise in column detection
    const bodyLines = lines.filter((l) => l.y > 0.05 && l.y < 0.95);
    const leftCount = bodyLines.filter((l) => l.x + l.w < 0.51).length;
    const rightCount = bodyLines.filter((l) => l.x > 0.49).length;
    const isTwoCol = leftCount >= 3 && rightCount >= 3;

    if (!isTwoCol) {
      return [lines.slice().sort((a, b) => a.y - b.y || a.x - b.x)];
    }

    // Separate full-width top (e.g. title/abstract), left col, right col, full-width bottom
    const fullSpan = [];
    const left = [];
    const right = [];

    for (const ln of lines) {
      const spansCenter = ln.x < 0.44 && ln.x + ln.w > 0.56;
      if (spansCenter) {
        fullSpan.push(ln);
      } else if (ln.x + ln.w * 0.5 < 0.5) {
        left.push(ln);
      } else {
        right.push(ln);
      }
    }

    const firstColY = Math.min(
      left[0]?.y ?? 1,
      right[0]?.y ?? 1
    );
    const lastColY = Math.max(
      left[left.length - 1]?.y ?? 0,
      right[right.length - 1]?.y ?? 0
    );

    const topFull = fullSpan.filter((l) => l.y <= firstColY + 0.03).sort((a, b) => a.y - b.y);
    const midFull = fullSpan.filter((l) => l.y > firstColY + 0.03 && l.y < lastColY - 0.02).sort((a, b) => a.y - b.y);
    const botFull = fullSpan.filter((l) => l.y >= lastColY - 0.02).sort((a, b) => a.y - b.y);

    left.sort((a, b) => a.y - b.y);
    right.sort((a, b) => a.y - b.y);

    // Return zones separately so clustering never merges across columns
    const zones = [];
    if (topFull.length) zones.push(topFull);
    if (midFull.length) zones.push(midFull);
    if (left.length) zones.push(left);
    if (right.length) zones.push(right);
    if (botFull.length) zones.push(botFull);
    return zones;
  }

  function clusterZoneLines(zoneLines, medianFont) {
    if (!zoneLines || zoneLines.length === 0) return [];
    const clusters = [];
    let cur = null;

    for (const ln of zoneLines) {
      const isShortHeader =
        ln.fontSize >= medianFont * 1.12 ||
        /^(Abstract|References|Bibliography|\d+\.(\d+\.)?\s+[A-Z])/.test(ln.text);
      const isCaptionStart = /^(Fig\.?|Figure|Table|Algorithm)\s*\d+/i.test(ln.text);

      if (!cur) {
        cur = {
          lines: [ln],
          minX: ln.x,
          minY: ln.y,
          maxX: ln.x + ln.w,
          maxY: ln.y + ln.h,
          fontSum: ln.fontSize
        };
        continue;
      }

      const prevLn = cur.lines[cur.lines.length - 1];
      const gapY = ln.y - (prevLn.y + prevLn.h);
      const typicalH = Math.max(0.01, prevLn.h);
      const fontChanged = Math.abs(ln.fontSize - prevLn.fontSize) > medianFont * 0.16;
      const curIsHeading = cur.lines.length <= 2 && cur.fontSum / cur.lines.length >= medianFont * 1.12;
      const xShift = Math.abs(ln.x - cur.minX) > 0.08 && prevLn.w < 0.28;

      const shouldSplit =
        gapY > typicalH * 0.95 ||
        fontChanged ||
        curIsHeading ||
        isShortHeader ||
        isCaptionStart ||
        xShift ||
        cur.lines.length >= 14;

      if (shouldSplit) {
        clusters.push(cur);
        cur = {
          lines: [ln],
          minX: ln.x,
          minY: ln.y,
          maxX: ln.x + ln.w,
          maxY: ln.y + ln.h,
          fontSum: ln.fontSize
        };
      } else {
        cur.lines.push(ln);
        cur.minX = Math.min(cur.minX, ln.x);
        cur.minY = Math.min(cur.minY, ln.y);
        cur.maxX = Math.max(cur.maxX, ln.x + ln.w);
        cur.maxY = Math.max(cur.maxY, ln.y + ln.h);
        cur.fontSum += ln.fontSize;
      }
    }
    if (cur) clusters.push(cur);

    return clusters.map((c) => {
      const text = c.lines
        .map((l) => l.text)
        .join(' ')
        .replace(/-\s+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const avgFont = c.fontSum / c.lines.length;
      const type = inferBlockType(text, avgFont, medianFont);
      return {
        type,
        text,
        bbox: [
          round4(clamp01(c.minX - 0.005)),
          round4(clamp01(c.minY - 0.003)),
          round4(clamp01(c.maxX - c.minX + 0.01)),
          round4(clamp01(c.maxY - c.minY + 0.006))
        ]
      };
    });
  }

  async function extractPageBlocks(page, pageNum) {
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    const lines = mergeItemsIntoLines(textContent.items || [], viewport);
    if (lines.length === 0) return [];

    const sortedFonts = lines.map((l) => l.fontSize).sort((a, b) => a - b);
    const medianFont = sortedFonts[Math.floor(sortedFonts.length / 2)] || 10;

    const zones = splitTwoColumns(lines);
    const blocks = [];
    let idx = 0;

    for (const z of zones) {
      const zoneBlocks = clusterZoneLines(z, medianFont);
      for (const blk of zoneBlocks) {
        // Filter out tiny single-number page footers
        if (/^(Page\s*)?\d{1,3}$/i.test(blk.text) && (blk.bbox[1] < 0.06 || blk.bbox[1] > 0.92)) {
          continue;
        }
        idx += 1;
        blocks.push({
          block_id: `p${pageNum}_b${idx}`,
          type: blk.type,
          text: blk.text,
          bbox: blk.bbox
        });
      }
    }
    return blocks;
  }

  function detectReferencesHeading(blocks) {
    return (blocks || []).some(
      (b) => /^(References|Bibliography|REFERENCES)$/i.test(String(b.text || '').trim())
    );
  }

  window.PdfBlocks = {
    extractPageBlocks,
    detectReferencesHeading
  };
})();
