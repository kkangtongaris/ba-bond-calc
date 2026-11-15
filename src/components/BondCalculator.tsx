import { useMemo, useState } from 'react';
import { calculateBondPlans } from '../core/favorLogic';
import type { BondGoal, GiftItem, GiftUsageMode, Student } from '../types/ba';

interface Props {
  selectedStudents: Student[];
  gifts: GiftItem[];
  ownedCounts: Record<number, number>;
  bondGoals: Record<number, BondGoal>;
  onUpdateGoal: (studentId: number, goal: BondGoal) => void;
  onConsumeGifts: (usedMap: Record<number, number>) => void;
}

export function BondCalculator({
  selectedStudents,
  gifts,
  ownedCounts,
  bondGoals,
  onUpdateGoal,
  onConsumeGifts,
}: Props) {
  const [usageMode, setUsageMode] = useState<GiftUsageMode>('preferred_only');
  const [drafts, setDrafts] = useState<
    Record<number, { current?: string; target?: string }>
  >({});

  const plans = useMemo(
    () =>
      calculateBondPlans(
        selectedStudents,
        gifts,
        ownedCounts,
        bondGoals,
        usageMode
      ),
    [selectedStudents, gifts, ownedCounts, bondGoals, usageMode]
  );

  if (selectedStudents.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h2>3. 인연 랭크 목표 경험치 계산기</h2>
        </div>
        <p className="empty-guide">
          위에서 육성할 학생을 선택하면 현재 랭크 → 목표 랭크까지 필요한 경험치와 보유 선물 배분량이 자동으로 계산됩니다.
        </p>
      </section>
    );
  }

  const handleCurrentChange = (studentId: number, raw: string, fallbackTarget: number) => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setDrafts((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId], current: digits },
    }));

    const parsed = parseInt(digits, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 99) {
      onUpdateGoal(studentId, {
        currentRank: parsed,
        targetRank: Math.max(parsed + 1, fallbackTarget),
      });
    }
  };

  const handleCurrentBlur = (studentId: number, currentRank: number, targetRank: number) => {
    const draftVal = drafts[studentId]?.current;
    if (draftVal !== undefined) {
      const parsed = parseInt(draftVal, 10);
      const validCurrent = Number.isNaN(parsed)
        ? currentRank
        : Math.max(1, Math.min(99, parsed));
      onUpdateGoal(studentId, {
        currentRank: validCurrent,
        targetRank: Math.max(validCurrent + 1, targetRank),
      });
      setDrafts((prev) => {
        const next = { ...prev };
        if (next[studentId]) {
          delete next[studentId].current;
        }
        return next;
      });
    }
  };

  const handleTargetChange = (studentId: number, raw: string, currentRank: number) => {
    const digits = raw.replace(/\D/g, '').slice(0, 3);
    setDrafts((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId], target: digits },
    }));

    const parsed = parseInt(digits, 10);
    if (!Number.isNaN(parsed) && parsed > currentRank && parsed <= 100) {
      onUpdateGoal(studentId, {
        currentRank,
        targetRank: parsed,
      });
    }
  };

  const handleTargetBlur = (studentId: number, currentRank: number, targetRank: number) => {
    const draftVal = drafts[studentId]?.target;
    if (draftVal !== undefined) {
      const parsed = parseInt(draftVal, 10);
      const validTarget = Number.isNaN(parsed)
        ? targetRank
        : Math.max(currentRank + 1, Math.min(100, parsed));
      onUpdateGoal(studentId, {
        currentRank,
        targetRank: validTarget,
      });
      setDrafts((prev) => {
        const next = { ...prev };
        if (next[studentId]) {
          delete next[studentId].target;
        }
        return next;
      });
    }
  };

  const handlePresetClick = (studentId: number, currentRank: number, presetRank: number) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[studentId];
      return next;
    });
    onUpdateGoal(studentId, {
      currentRank,
      targetRank: Math.max(currentRank + 1, presetRank),
    });
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>3. 인연 랭크 목표 경험치 계산기</h2>
        <div className="calc-mode-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={usageMode === 'include_neutral'}
              onChange={(e) =>
                setUsageMode(e.target.checked ? 'include_neutral' : 'preferred_only')
              }
            />
            비선호(일반 +20/+120) 선물까지 직접 포함해서 계산
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={usageMode === 'synthesize_neutral'}
              onChange={(e) =>
                setUsageMode(e.target.checked ? 'synthesize_neutral' : 'preferred_only')
              }
            />
            비선호 2★ 선물을 전부 선택상자(2:1 합성)로 바꿔서 계산
          </label>
        </div>
      </div>

      <div className="calc-list">
        {plans.map((plan) => {
          const isComplete = plan.shortageExp === 0;
          const progressPct =
            plan.requiredExp > 0
              ? Math.min(100, Math.round((plan.gainedExp / plan.requiredExp) * 100))
              : 100;

          const currentDisplay =
            drafts[plan.student.id]?.current ?? String(plan.currentRank);
          const targetDisplay =
            drafts[plan.student.id]?.target ?? String(plan.targetRank);

          return (
            <div key={plan.student.id} className="calc-card">
              <div className="calc-top">
                <div className="calc-student">
                  <img src={plan.student.iconUrl} alt={plan.student.name} />
                  <div>
                    <div className="calc-student-name">{plan.student.name}</div>
                    <div className="calc-exp-summary">
                      필요 경험치: <strong>{plan.requiredExp.toLocaleString()} EXP</strong>
                    </div>
                  </div>
                </div>

                <div className="calc-inputs">
                  <label>
                    현재
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="1"
                      value={currentDisplay}
                      onChange={(e) =>
                        handleCurrentChange(
                          plan.student.id,
                          e.target.value,
                          plan.targetRank
                        )
                      }
                      onBlur={() =>
                        handleCurrentBlur(
                          plan.student.id,
                          plan.currentRank,
                          plan.targetRank
                        )
                      }
                    />
                  </label>
                  <span className="arrow">→</span>
                  <label>
                    목표
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="20"
                      value={targetDisplay}
                      onChange={(e) =>
                        handleTargetChange(
                          plan.student.id,
                          e.target.value,
                          plan.currentRank
                        )
                      }
                      onBlur={() =>
                        handleTargetBlur(
                          plan.student.id,
                          plan.currentRank,
                          plan.targetRank
                        )
                      }
                    />
                  </label>
                  <div className="preset-btns">
                    {[20, 50, 100].map((lv) => (
                      <button
                        key={lv}
                        type="button"
                        onClick={() =>
                          handlePresetClick(plan.student.id, plan.currentRank, lv)
                        }
                      >
                        Lv.{lv}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="progress-wrap">
                <div className="progress-bar">
                  <div
                    className={`progress-fill ${isComplete ? 'done' : ''}`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="progress-text">
                  {isComplete ? (
                    <span className="text-ok">
                      ✅ 보유 선물로 목표 달성 가능! (예상 도달: Lv.{plan.estimatedRank})
                    </span>
                  ) : (
                    <span className="text-warn">
                      보유 선물 투입 시 <strong>Lv.{plan.estimatedRank}</strong> 도달 ({progressPct}%) ·{' '}
                      <strong>{plan.shortageExp.toLocaleString()} EXP</strong> 부족 (40pt 선물 약{' '}
                      {Math.ceil(plan.shortageExp / 40)}개 / 60pt 선물 약{' '}
                      {Math.ceil(plan.shortageExp / 60)}개 분량)
                    </span>
                  )}
                </div>
              </div>

              {plan.allocatedGifts.length > 0 ? (
                <div className="alloc-section">
                  <div className="alloc-header">
                    <span>추천 투입 선물 ({plan.gainedExp.toLocaleString()} EXP 확보)</span>
                    <button
                      type="button"
                      className="consume-btn"
                      onClick={() => onConsumeGifts(plan.consumedMap)}
                      title="인게임에서 실제로 선물을 먹인 뒤 클릭하면 보유 수량에서 자동 차감됩니다"
                    >
                      사용 완료 (보유 수량에서 차감)
                    </button>
                  </div>
                  <div className="alloc-chips">
                    {plan.allocatedGifts.map((item, idx) => (
                      <div
                        key={`${item.gift.id}-${item.isSynthesized ? 'syn' : 'own'}-${idx}`}
                        className={`alloc-chip ${item.isSynthesized ? 'synthesized' : ''}`}
                      >
                        <img src={item.gift.iconUrl} alt={item.gift.name} />
                        <span className="alloc-name">
                          {item.isSynthesized
                            ? `[합성] ${item.gift.name} (재료 ${item.synthesizedMaterialCount}개)`
                            : item.gift.name}
                        </span>
                        <span className="alloc-count">×{item.useCount}</span>
                        <span className="alloc-exp">+{item.expPerItem}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="no-alloc">
                  투입 가능한 보유 선물이 없습니다. 위에서 선물 보유량을 입력하거나 스캔해 주세요.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}