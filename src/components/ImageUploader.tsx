import { useEffect, useState } from 'react';
import { scanGiftScreenshot, type ScannedGiftResult } from '../core/imageScanner';
import type { GiftItem } from '../types/ba';

interface Props {
  gifts: GiftItem[];
  onApplyCounts: (detected: Record<number, number>, replaceAll: boolean) => void;
}

export function ImageUploader({ gifts, onApplyCounts }: Props) {
  const [isScanning, setIsScanning] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [results, setResults] = useState<ScannedGiftResult[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [replaceAll, setReplaceAll] = useState(false);

  const processFile = async (file: File) => {
    if (!file.type.startsWith('image/') || isScanning) return;
    setIsScanning(true);
    setErrorMsg(null);
    setResults([]);

    try {
      const scanned = await scanGiftScreenshot(file, gifts, setProgressMsg);
      if (scanned.length === 0) {
        setErrorMsg(
          '선물 아이콘을 찾지 못했습니다. 인게임 아이템 가방(선물 탭) 또는 카페 선물 창 전체 화면을 캡처해 주세요.'
        );
      } else {
        setResults(scanned);
      }
    } catch (err: any) {
      setErrorMsg(err?.message ?? '이미지 분석 중 오류가 발생했습니다.');
    } finally {
      setIsScanning(false);
      setProgressMsg('');
    }
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            processFile(file);
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  });

  const handleCountEdit = (idx: number, raw: string) => {
    const val = Math.max(0, parseInt(raw, 10) || 0);
    setResults((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, count: val } : item))
    );
  };

  const handleApply = () => {
    const detected: Record<number, number> = {};
    for (const item of results) {
      detected[item.gift.id] = (detected[item.gift.id] ?? 0) + item.count;
    }
    onApplyCounts(detected, replaceAll);
    setResults([]);
  };

  return (
    <div className="uploader-box">
      {isScanning && (
        <div className="scan-overlay" role="dialog" aria-modal="true">
          <div className="scan-modal">
            <div className="scan-spinner-lg" />
            <div className="scan-modal-title">스크린샷 분석 중</div>
            <div className="scan-modal-desc">
              {progressMsg || '이미지 분석을 준비하고 있습니다...'}
            </div>
          </div>
        </div>
      )}

      <div className="uploader-actions">
        <label className="upload-btn">
          인게임 선물 창 스크린샷 업로드 (또는 Ctrl+V 붙여넣기)
          <input
            type="file"
            accept="image/*"
            disabled={isScanning}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) processFile(file);
              e.target.value = '';
            }}
            hidden
          />
        </label>
      </div>

      <p className="uploader-hint">
        아이템 가방(선물 탭) 또는 카페 선물 창 스크린샷을 올려주세요. (PC는 Win+Shift+S 캡처 후 Ctrl+V 가능)
      </p>

      {errorMsg && <div className="scan-error">{errorMsg}</div>}

      {results.length > 0 && (
        <div className="scan-results">
          <div className="scan-results-header">
            <strong>
              인식 결과 확인 ({results.length}종) — 잘못 읽힌 숫자가 있다면 수정 후 적용하세요
            </strong>
            <div className="scan-apply-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={replaceAll}
                  onChange={(e) => setReplaceAll(e.target.checked)}
                />
                기존 입력값 초기화 후 덮어쓰기
              </label>
              <button type="button" className="apply-btn" onClick={handleApply}>
                보유 수량에 반영하기
              </button>
            </div>
          </div>

          <div className="scan-grid">
            {results.map((item, idx) => (
              <div key={`${item.gift.id}-${idx}`} className="scan-item">
                <img
                  src={item.gift.iconUrl}
                  alt={item.gift.name}
                  className="scan-gift-icon"
                />
                <div className="scan-item-body">
                  <div className="scan-gift-name" title={item.gift.name}>
                    {item.gift.name}
                  </div>
                  <div className="scan-ocr-row">
                    <img
                      src={item.previewDataUrl}
                      alt="OCR 크롭"
                      className="ocr-preview"
                      title="인식된 숫자 영역"
                    />
                    <input
                      type="number"
                      min={0}
                      value={item.count}
                      onChange={(e) => handleCountEdit(idx, e.target.value)}
                      className="scan-count-input"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}