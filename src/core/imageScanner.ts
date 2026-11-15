import { createWorker, PSM } from 'tesseract.js';
import type { GiftItem } from '../types/ba';

export interface ScannedGiftResult {
  gift: GiftItem;
  count: number;
  confidence: number;
  previewDataUrl: string;
}

interface ColorTemplate {
  gift: GiftItem;
  indices: Int32Array;
  jointVec: Float32Array;
  std: number;
}

interface CleanedDigitBox {
  canvas: HTMLCanvasElement;
  hasValidDigits: boolean;
  xStripped: boolean;
}

interface RawMatch {
  tpl: ColorTemplate;
  x: number;
  y: number;
  iconW: number;
  iconH: number;
  score: number;
}

const GRID = 16;
const TOTAL_CELLS = GRID * GRID;
const ICON_ASPECT = 1.12;

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`이미지 로드 실패: ${url}`));
    img.src = url;
  });
}

async function buildColorTemplates(gifts: GiftItem[]): Promise<ColorTemplate[]> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 56;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const results = await Promise.allSettled(
    gifts.map(async (gift): Promise<ColorTemplate> => {
      const img = await loadImage(gift.iconUrl);
      ctx.clearRect(0, 0, 64, 56);
      ctx.drawImage(img, 0, 0, 64, 56);
      const { data } = ctx.getImageData(0, 0, 64, 56);

      const validIdx: number[] = [];
      const rawRGB: number[] = [];

      for (let gy = 0; gy < GRID; gy++) {
        const py = Math.round(((gy + 0.5) / GRID) * 48) + 4;
        for (let gx = 0; gx < GRID; gx++) {
          const px = Math.round(((gx + 0.5) / GRID) * 56) + 4;
          const offset = (py * 64 + px) * 4;
          const alpha = data[offset + 3];

          if (alpha > 170) {
            validIdx.push(gy * GRID + gx);
            rawRGB.push(data[offset], data[offset + 1], data[offset + 2]);
          }
        }
      }

      if (validIdx.length < 16) {
        throw new Error('유효 픽셀 부족');
      }

      const n = rawRGB.length;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += rawRGB[i];
      const mean = sum / n;

      const jointVec = new Float32Array(n);
      let normSq = 0;
      for (let i = 0; i < n; i++) {
        const d = rawRGB[i] - mean;
        jointVec[i] = d;
        normSq += d * d;
      }

      const std = Math.sqrt(normSq / n);
      const inv = normSq > 1 ? 1 / Math.sqrt(normSq) : 0;
      for (let i = 0; i < n; i++) {
        jointVec[i] *= inv;
      }

      return {
        gift,
        indices: Int32Array.from(validIdx),
        jointVec,
        std,
      };
    })
  );

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}

function sampleWindowRGB(
  pixels: Uint8ClampedArray,
  imgW: number,
  bx: number,
  by: number,
  iconW: number,
  iconH: number,
  outR: Float32Array,
  outG: Float32Array,
  outB: Float32Array,
  minVariance = 180
): boolean {
  const patchW = iconW * 0.88;
  const patchH = iconH * 0.86;
  const startX = bx + iconW * 0.06;
  const startY = by + iconH * 0.07;

  let sumLum = 0;
  let sumLumSq = 0;

  for (let gy = 0; gy < GRID; gy++) {
    const py = Math.round(startY + ((gy + 0.5) / GRID) * patchH);
    const rowOffset = py * imgW;
    for (let gx = 0; gx < GRID; gx++) {
      const px = Math.round(startX + ((gx + 0.5) / GRID) * patchW);
      const off = (rowOffset + px) * 4;
      const r = pixels[off];
      const g = pixels[off + 1];
      const b = pixels[off + 2];
      const idx = gy * GRID + gx;
      outR[idx] = r;
      outG[idx] = g;
      outB[idx] = b;

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumLum += lum;
      sumLumSq += lum * lum;
    }
  }

  const meanLum = sumLum / TOTAL_CELLS;
  const variance = sumLumSq / TOTAL_CELLS - meanLum * meanLum;
  return variance > minVariance;
}

function scoreTemplate(
  tpl: ColorTemplate,
  winR: Float32Array,
  winG: Float32Array,
  winB: Float32Array
): number {
  const idx = tpl.indices;
  const len = idx.length;
  const n = len * 3;

  let sum = 0;
  for (let i = 0; i < len; i++) {
    const k = idx[i];
    sum += winR[k] + winG[k] + winB[k];
  }
  const mean = sum / n;

  let dot = 0;
  let normSq = 0;
  const tVec = tpl.jointVec;

  for (let i = 0; i < len; i++) {
    const k = idx[i];
    const dr = winR[k] - mean;
    const dg = winG[k] - mean;
    const db = winB[k] - mean;

    const base = i * 3;
    dot += dr * tVec[base] + dg * tVec[base + 1] + db * tVec[base + 2];
    normSq += dr * dr + dg * dg + db * db;
  }

  if (normSq < 100) return 0;

  const winStd = Math.sqrt(normSq / n);
  const stdRatio = winStd / Math.max(1, tpl.std);
  if (stdRatio < 0.4 || stdRatio > 2.4) return 0;

  return dot / Math.sqrt(normSq);
}

function clusterCoordinates(coords: number[], tolerance: number): number[] {
  const sorted = [...coords].sort((a, b) => a - b);
  const clusters: number[][] = [];

  for (const val of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(val - last[last.length - 1]) <= tolerance) {
      last.push(val);
    } else {
      clusters.push([val]);
    }
  }

  return clusters.map((group) => group[Math.floor(group.length / 2)]);
}

function extractCleanDigits(
  sharpCanvas: HTMLCanvasElement,
  ox: number,
  oy: number,
  ow: number,
  oh: number
): CleanedDigitBox {
  const emptyCanvas = document.createElement('canvas');
  emptyCanvas.width = 80;
  emptyCanvas.height = 40;

  if (oy + oh * 1.25 > sharpCanvas.height) {
    return { canvas: emptyCanvas, hasValidDigits: false, xStripped: false };
  }

  // 아이콘 내부 우측 하단의 수량 표시 영역을 정확히 타겟팅하도록 위쪽으로 조정
  const cropX = ox + ow * 0.28;
  const cropY = oy + oh * 0.72;
  const cropW = ow * 0.7;
  const cropH = oh * 0.32;

  if (cropW < 10 || cropH < 6) {
    return { canvas: emptyCanvas, hasValidDigits: false, xStripped: false };
  }

  const targetH = 68;
  const scale = targetH / Math.max(1, cropH);
  const w = Math.max(24, Math.round(cropW * scale));
  const h = targetH;

  const temp = document.createElement('canvas');
  temp.width = w;
  temp.height = h;
  const tCtx = temp.getContext('2d', { willReadFrequently: true })!;
  tCtx.imageSmoothingEnabled = true;
  tCtx.imageSmoothingQuality = 'high';
  tCtx.drawImage(sharpCanvas, cropX, cropY, cropW, cropH, 0, 0, w, h);

  return { canvas: temp, hasValidDigits: true, xStripped: false };
}

export async function scanGiftScreenshot(
  file: File,
  gifts: GiftItem[],
  onProgress?: (msg: string) => void
): Promise<ScannedGiftResult[]> {
  onProgress?.('선물 아이콘 컬러 마스크 생성 중...');
  const templates = await buildColorTemplates(gifts);
  if (templates.length === 0) {
    throw new Error('선물 아이콘 템플릿을 불러오지 못했습니다.');
  }

  onProgress?.('스크린샷에서 선물 위치 탐색 중...');
  const objectUrl = URL.createObjectURL(file);
  const img = await loadImage(objectUrl);
  URL.revokeObjectURL(objectUrl);

  const sharpCanvas = document.createElement('canvas');
  sharpCanvas.width = img.width;
  sharpCanvas.height = img.height;
  sharpCanvas.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0);

  const normH = 540;
  const normW = Math.round((img.width / img.height) * normH);
  const searchCanvas = document.createElement('canvas');
  searchCanvas.width = normW;
  searchCanvas.height = normH;
  const sCtx = searchCanvas.getContext('2d', { willReadFrequently: true })!;
  sCtx.filter = 'blur(1px)';
  sCtx.drawImage(img, 0, 0, normW, normH);

  const { data: pixels } = sCtx.getImageData(0, 0, normW, normH);
  const winR = new Float32Array(TOTAL_CELLS);
  const winG = new Float32Array(TOTAL_CELLS);
  const winB = new Float32Array(TOTAL_CELLS);

  const candidateWidths = [62, 66, 70, 74, 78, 82];
  const rawMatches: RawMatch[] = [];

  for (const iconW of candidateWidths) {
    await yieldToMain();
    const iconH = Math.round(iconW / ICON_ASPECT);
    const maxX = Math.floor(normW - iconW);
    const maxY = Math.floor(normH - iconH * 1.15);

    for (let y = 0; y <= maxY; y += 3) {
      for (let x = 0; x <= maxX; x += 3) {
        if (!sampleWindowRGB(pixels, normW, x, y, iconW, iconH, winR, winG, winB, 180)) {
          continue;
        }

        let bestScore = 0.72;
        let bestTpl: ColorTemplate | null = null;

        for (let t = 0; t < templates.length; t++) {
          const s = scoreTemplate(templates[t], winR, winG, winB);
          if (s > bestScore) {
            bestScore = s;
            bestTpl = templates[t];
          }
        }

        if (bestTpl) {
          let fineX = x;
          let fineY = y;
          let fineScore = bestScore;

          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx > maxX || ny > maxY) continue;
              if (!sampleWindowRGB(pixels, normW, nx, ny, iconW, iconH, winR, winG, winB, 180)) {
                continue;
              }
              const s = scoreTemplate(bestTpl, winR, winG, winB);
              if (s > fineScore) {
                fineScore = s;
                fineX = nx;
                fineY = ny;
              }
            }
          }

          if (fineScore >= 0.76) {
            rawMatches.push({
              tpl: bestTpl,
              x: fineX,
              y: fineY,
              iconW,
              iconH,
              score: fineScore,
            });
          }
        }
      }
    }
  }

  rawMatches.sort((a, b) => b.score - a.score);
  const deduped: RawMatch[] = [];
  const seenGiftIds = new Set<number>();

  for (const cand of rawMatches) {
    if (seenGiftIds.has(cand.tpl.gift.id)) continue;

    const overlaps = deduped.some(
      (kept) =>
        Math.abs(kept.x - cand.x) < cand.iconW * 0.7 &&
        Math.abs(kept.y - cand.y) < cand.iconH * 0.7
    );
    if (!overlaps) {
      deduped.push(cand);
      seenGiftIds.add(cand.tpl.gift.id);
    }
  }

  let finalMatches: RawMatch[] = [];

  if (deduped.length > 0) {
    const widthCounts = new Map<number, number>();
    for (const m of deduped) {
      widthCounts.set(m.iconW, (widthCounts.get(m.iconW) ?? 0) + 1);
    }
    let dominantW = deduped[0].iconW;
    let maxCount = 0;
    for (const [w, cnt] of widthCounts.entries()) {
      if (cnt > maxCount) {
        maxCount = cnt;
        dominantW = w;
      }
    }
    const dominantH = Math.round(dominantW / ICON_ASPECT);

    finalMatches = deduped.filter(
      (m) => Math.abs(m.iconW - dominantW) <= 6 && m.y + dominantH * 1.24 <= normH
    );

    if (finalMatches.length >= 4) {
      const colXs = clusterCoordinates(
        finalMatches.map((m) => m.x),
        dominantW * 0.35
      );
      const rowYs = clusterCoordinates(
        finalMatches.map((m) => m.y),
        dominantH * 0.35
      ).filter((ry) => ry + dominantH * 1.24 <= normH);

      for (const ry of rowYs) {
        for (const cx of colXs) {
          const occupied = finalMatches.some(
            (m) => Math.abs(m.x - cx) < dominantW * 0.5 && Math.abs(m.y - ry) < dominantH * 0.5
          );
          if (occupied) continue;

          let bestCellScore = 0.55;
          let bestCellMatch: RawMatch | null = null;

          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const nx = cx + dx;
              const ny = ry + dy;
              if (nx < 0 || ny < 0 || nx + dominantW > normW || ny + dominantH > normH) continue;
              if (!sampleWindowRGB(pixels, normW, nx, ny, dominantW, dominantH, winR, winG, winB)) {
                continue;
              }
              for (let t = 0; t < templates.length; t++) {
                if (seenGiftIds.has(templates[t].gift.id)) continue;
                const s = scoreTemplate(templates[t], winR, winG, winB);
                if (s > bestCellScore) {
                  bestCellScore = s;
                  bestCellMatch = {
                    tpl: templates[t],
                    x: nx,
                    y: ny,
                    iconW: dominantW,
                    iconH: dominantH,
                    score: s,
                  };
                }
              }
            }
          }

          if (bestCellMatch) {
            finalMatches.push(bestCellMatch);
            seenGiftIds.add(bestCellMatch.tpl.gift.id);
          }
        }
      }
    }
  }

  if (finalMatches.length === 0) {
    return [];
  }

  finalMatches.sort((a, b) =>
    Math.abs(a.y - b.y) > 25 ? a.y - b.y : a.x - b.x
  );

  onProgress?.(`${finalMatches.length}개 선물 발견! 보유 수량 숫자 읽는 중...`);
  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
  });

  const scaleToOrig = img.height / normH;
  const scanned: ScannedGiftResult[] = [];

  for (let i = 0; i < finalMatches.length; i++) {
    const m = finalMatches[i];
    onProgress?.(`숫자 판독 중 (${i + 1} / ${finalMatches.length})...`);

    const cleaned = extractCleanDigits(
      sharpCanvas,
      m.x * scaleToOrig,
      m.y * scaleToOrig,
      m.iconW * scaleToOrig,
      m.iconH * scaleToOrig
    );

    if (!cleaned.hasValidDigits) {
      continue;
    }

    await worker.setParameters({
      tessedit_char_whitelist: 'xX0123456789',
    });

    const { data } = await worker.recognize(cleaned.canvas);
    const afterX = data.text.replace(/^.*[xX]/, '');
    const digits = afterX.replace(/\D/g, '');
    const count = digits ? parseInt(digits, 10) : 1;

    scanned.push({
      gift: m.tpl.gift,
      count,
      confidence: Math.round(m.score * 100),
      previewDataUrl: cleaned.canvas.toDataURL('image/png'),
    });
  }

  await worker.terminate();
  return scanned;
}