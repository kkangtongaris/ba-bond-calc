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

const GRID = 16;
const TOTAL_CELLS = GRID * GRID;
const ICON_ASPECT = 1.12;

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
  outB: Float32Array
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
  return variance > 180;
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

// 연결 요소(블롭) 분석으로 위쪽에서 삐져나온 아이콘 조각과 앞글자 'x'를 지우고 순수 숫자만 추출
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

  // 하단 수량 바가 화면 밖으로 잘린 경우(스크롤 맨 아래 줄) 즉시 무효 처리
  if (oy + oh * 1.28 > sharpCanvas.height) {
    return { canvas: emptyCanvas, hasValidDigits: false, xStripped: false };
  }

  let cropX = Math.max(0, ox + ow * 0.28);
  let cropY = Math.max(0, oy + oh * 1.02);
  let cropW = Math.min(sharpCanvas.width - cropX, ow * 0.7);
  let cropH = Math.min(sharpCanvas.height - cropY, oh * 0.31);

  if (cropW < 10 || cropH < 6) {
    return { canvas: emptyCanvas, hasValidDigits: false, xStripped: false };
  }

  const probeCtx = sharpCanvas.getContext('2d', { willReadFrequently: true })!;
  const probeData = probeCtx.getImageData(
    Math.round(cropX),
    Math.round(cropY),
    Math.round(cropW),
    Math.round(cropH)
  ).data;

  let whitePixels = 0;
  const totalPixels = probeData.length / 4;
  for (let i = 0; i < probeData.length; i += 4) {
    const lum = 0.299 * probeData[i] + 0.587 * probeData[i + 1] + 0.114 * probeData[i + 2];
    if (lum > 230) whitePixels++;
  }

  // 카페 선물 창처럼 아래 흰색 바가 없는 경우 우측 하단 내부 사용
  if (whitePixels / Math.max(1, totalPixels) < 0.22) {
    cropX = Math.max(0, ox + ow * 0.35);
    cropY = Math.max(0, oy + oh * 0.65);
    cropW = Math.min(sharpCanvas.width - cropX, ow * 0.63);
    cropH = Math.min(sharpCanvas.height - cropY, oh * 0.34);
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

  const imgData = tCtx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // 어두운 글씨 픽셀 마스크 생성
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const off = i * 4;
    const lum = 0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2];
    if (lum < 175) {
      mask[i] = 1;
    }
  }

  // BFS로 연결된 픽셀 덩어리(블롭) 분리
  const visited = new Uint8Array(w * h);
  interface BlobInfo {
    pixels: number[];
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }
  const blobs: BlobInfo[] = [];
  const queue = new Int32Array(w * h);

  for (let start = 0; start < w * h; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    const pixels: number[] = [];

    while (head < tail) {
      const curr = queue[head++];
      pixels.push(curr);
      const cx = curr % w;
      const cy = (curr - cx) / w;

      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      // 8방향 이웃 탐색
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const next = ny * w + nx;
          if (mask[next] === 1 && visited[next] === 0) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }

    blobs.push({ pixels, minX, maxX, minY, maxY });
  }

  // 위쪽 테두리(minY <= 2)나 좌우 끝에 붙어 있는 아이콘 조각·노이즈 제거
  const charBlobs = blobs.filter((b) => {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    if (b.minY <= 2 || b.minX <= 1 || b.maxX >= w - 1) return false;
    if (bh < 12 || bh > h * 0.78) return false;
    if (bw < 3 || bw > h * 0.75) return false;
    return true;
  });

  if (charBlobs.length === 0) {
    return { canvas: emptyCanvas, hasValidDigits: false, xStripped: false };
  }

  // 왼쪽에서 오른쪽 순서로 정렬
  charBlobs.sort((a, b) => a.minX - b.minX);

  // 맨 왼쪽 블롭이 뒤따르는 숫자들보다 키가 작으면 소문자 'x'이므로 제거
  let xStripped = false;
  let digitBlobs = charBlobs;
  if (charBlobs.length >= 2) {
    const maxCharH = Math.max(...charBlobs.map((b) => b.maxY - b.minY + 1));
    const firstH = charBlobs[0].maxY - charBlobs[0].minY + 1;
    if (firstH < maxCharH * 0.86) {
      digitBlobs = charBlobs.slice(1);
      xStripped = true;
    }
  }

  // 살아남은 순수 숫자 픽셀만 남기고 나머지(아이콘 조각, 테두리)는 전부 순백색으로 지움
  const keepPixel = new Uint8Array(w * h);
  for (const b of digitBlobs) {
    for (const p of b.pixels) {
      keepPixel[p] = 1;
    }
  }

  for (let i = 0; i < w * h; i++) {
    const off = i * 4;
    if (keepPixel[i] === 1) {
      const lum = 0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2];
      const cleanVal = Math.max(0, Math.min(255, (lum - 30) * 1.15));
      d[off] = cleanVal;
      d[off + 1] = cleanVal;
      d[off + 2] = cleanVal;
      d[off + 3] = 255;
    } else {
      d[off] = 255;
      d[off + 1] = 255;
      d[off + 2] = 255;
      d[off + 3] = 255;
    }
  }
  tCtx.putImageData(imgData, 0, 0);

  // 살아남은 숫자 영역만 타이트하게 잘라 이탤릭 기울기 보정 후 출력
  const minDigitX = Math.min(...digitBlobs.map((b) => b.minX));
  const maxDigitX = Math.max(...digitBlobs.map((b) => b.maxX));
  const minDigitY = Math.min(...digitBlobs.map((b) => b.minY));
  const maxDigitY = Math.max(...digitBlobs.map((b) => b.maxY));

  const boxW = maxDigitX - minDigitX + 1;
  const boxH = maxDigitY - minDigitY + 1;
  const pad = 18;
  const slantShift = Math.round(boxH * 0.22);

  const out = document.createElement('canvas');
  out.width = boxW + slantShift + pad * 2;
  out.height = boxH + pad * 2;
  const outCtx = out.getContext('2d', { willReadFrequently: true })!;

  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.setTransform(1, 0, 0.22, 1, pad, pad);
  outCtx.drawImage(temp, minDigitX, minDigitY, boxW, boxH, 0, 0, boxW, boxH);
  outCtx.setTransform(1, 0, 0, 1, 0, 0);

  return { canvas: out, hasValidDigits: true, xStripped };
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

  const candidateWidths = [60, 65, 70, 75, 80];
  const winR = new Float32Array(TOTAL_CELLS);
  const winG = new Float32Array(TOTAL_CELLS);
  const winB = new Float32Array(TOTAL_CELLS);

  interface RawMatch {
    tpl: ColorTemplate;
    x: number;
    y: number;
    iconW: number;
    iconH: number;
    score: number;
  }

  const rawMatches: RawMatch[] = [];

  for (const iconW of candidateWidths) {
    const iconH = Math.round(iconW / ICON_ASPECT);
    const maxX = Math.floor(normW - iconW);
    const maxY = Math.floor(normH - iconH * 1.25);

    for (let y = 0; y <= maxY; y += 3) {
      for (let x = 0; x <= maxX; x += 3) {
        if (!sampleWindowRGB(pixels, normW, x, y, iconW, iconH, winR, winG, winB)) {
          continue;
        }

        let bestScore = 0.7;
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
              if (!sampleWindowRGB(pixels, normW, nx, ny, iconW, iconH, winR, winG, winB)) {
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
  const dedupedMatches: RawMatch[] = [];
  const seenGiftIds = new Set<number>();

  for (const cand of rawMatches) {
    if (seenGiftIds.has(cand.tpl.gift.id)) continue;

    const overlaps = dedupedMatches.some(
      (kept) =>
        Math.abs(kept.x - cand.x) < cand.iconW * 0.7 &&
        Math.abs(kept.y - cand.y) < cand.iconH * 0.7
    );
    if (!overlaps) {
      dedupedMatches.push(cand);
      seenGiftIds.add(cand.tpl.gift.id);
    }
  }

  if (dedupedMatches.length === 0) {
    return [];
  }

  const widthCounts = new Map<number, number>();
  for (const m of dedupedMatches) {
    widthCounts.set(m.iconW, (widthCounts.get(m.iconW) ?? 0) + 1);
  }
  let dominantW = dedupedMatches[0].iconW;
  let maxCount = 0;
  for (const [w, cnt] of widthCounts.entries()) {
    if (cnt > maxCount) {
      maxCount = cnt;
      dominantW = w;
    }
  }
  const dominantH = Math.round(dominantW / ICON_ASPECT);

  // 하단 수량 바까지 화면 안에 온전히 들어온 카드만 유지
  const finalMatches = dedupedMatches.filter(
    (m) => Math.abs(m.iconW - dominantW) <= 6 && m.y + dominantH * 1.28 <= normH
  );

  if (finalMatches.length >= 4) {
    const colXs = clusterCoordinates(
      finalMatches.map((m) => m.x),
      dominantW * 0.35
    );
    const rowYs = clusterCoordinates(
      finalMatches.map((m) => m.y),
      dominantH * 0.35
    ).filter((ry) => ry + dominantH * 1.28 <= normH);

    for (const m of finalMatches) {
      const snapX = colXs.find((cx) => Math.abs(cx - m.x) <= dominantW * 0.35);
      const snapY = rowYs.find((ry) => Math.abs(ry - m.y) <= dominantH * 0.35);
      if (snapX !== undefined) m.x = snapX;
      if (snapY !== undefined) m.y = snapY;
      m.iconW = dominantW;
      m.iconH = dominantH;
    }

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
                  x: cx,
                  y: ry,
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
      tessedit_char_whitelist: cleaned.xStripped ? '0123456789' : 'x0123456789',
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