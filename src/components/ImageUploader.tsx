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
    if (!file.type.startsWith('image/')) return;
    setIsScanning(true);
    setErrorMsg(null);
    setResults([]);

    try {
      const scanned = await scanGiftScreenshot(file, gifts, setProgressMsg);
      if (scanned.length === 0) {
        setErrorMsg(
          '선물 아이콘을 찾지 못했습니다. 인게임 카페 선물 창이나 아이템 가방의 선물 탭 전체 화면을 캡처해 주세요.'
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

  // 페이지 어디서든 Ctrl+V로 클립보드 스크린샷 바로 인식
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) processFile(file);
          break;
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [gifts]);

  const updateScannedCount = (index: number, val: string) => {
    const num = Math.max(0, parseInt(val, 10) || 0);
    setResults((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, count: num } : item))
    );
  };

  const handleApply = () => {
    const map: Record<number, number> = {};
    for (const item of results) {
      // 스크롤 겹침 등으로 동일 선물이 중복 인식된 경우 최댓값 사용
      map[item.gift.id] = Math.max(map[item.gift.id] ?? 0, item.count);
    }
    onApplyCounts(map, replaceAll);
    setResults([]);
  };

  return (
    <div className="uploader-box">
      <div className="uploader-top">
        <label className="upload-btn">
          📷 인게임 선물 창 스크린샷 업로드 (또는 Ctrl+V 붙여넣기)
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={isScanning}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) processFile(file);
              e.target.value = '';
            }}
          />
        </label>
        <span className="upload-hint">
          Win+Shift+S로 선물 목록을 캡처한 뒤 화면에 바로 Ctrl+V를 눌러도 인식됩니다.
        </span>
      </div>

      {isScanning && <div className="scan-status">⏳ {progressMsg}</div>}
      {errorMsg && <div className="scan-error">⚠️ {errorMsg}</div>}

      {results.length > 0 && (
        <div className="scan-results">
          <div className="scan-results-header">
            <strong>인식 결과 확인 ({results.length}종) — 잘못 읽힌 숫자가 있다면 수정 후 적용하세요</strong>
            <div className="scan-actions">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={replaceAll}
                  onChange={(e) => setReplaceAll(e.target.checked)}
                />
                기존 입력값 초기화 후 덮어쓰기
              </label>
              <button className="apply-btn" onClick={handleApply}>
                보유 수량에 반영하기
              </button>
            </div>
          </div>

          <div className="scan-grid">
            {results.map((item, idx) => (
              <div key={`${item.gift.id}-${idx}`} className="scan-item">
                <img src={item.gift.iconUrl} alt={item.gift.name} className="scan-icon" />
                <div className="scan-meta">
                  <div className="scan-name">{item.gift.name}</div>
                  <div className="scan-edit-row">
                    <img
                      src={item.previewDataUrl}
                      alt="인식 영역"
                      className="ocr-crop"
                      title="OCR이 읽은 숫자 영역"
                    />
                    <input
                      type="number"
                      min={0}
                      value={item.count}
                      onChange={(e) => updateScannedCount(idx, e.target.value)}
                      className="count-input"
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