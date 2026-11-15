import { useEffect, useMemo, useState } from 'react';
import { fetchSchaleData } from './api/schaleDb';
import { BondCalculator } from './components/BondCalculator';
import { ImageUploader } from './components/ImageUploader';
import { analyzeGiftsForStudents } from './core/favorLogic';
import type { BondGoal, GiftItem, Student } from './types/ba';
import './App.css';

const STORAGE_KEYS = {
  SELECTED_STUDENTS: 'ba_calc_selected_students_v1',
  OWNED_GIFTS: 'ba_calc_owned_gifts_v1',
  BOND_GOALS: 'ba_calc_bond_goals_v1',
};

export default function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [gifts, setGifts] = useState<GiftItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'crafting' | 'calculator'>('crafting');

  const [selectedIds, setSelectedIds] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SELECTED_STUDENTS);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [ownedCounts, setOwnedCounts] = useState<Record<number, number>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.OWNED_GIFTS);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [bondGoals, setBondGoals] = useState<Record<number, BondGoal>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.BOND_GOALS);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [includeJp, setIncludeJp] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'craftable' | 'preferred'>('all');

  useEffect(() => {
    fetchSchaleData()
      .then((data) => {
        setStudents(data.students);
        setGifts(data.gifts);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SELECTED_STUDENTS, JSON.stringify(selectedIds));
  }, [selectedIds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.OWNED_GIFTS, JSON.stringify(ownedCounts));
  }, [ownedCounts]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.BOND_GOALS, JSON.stringify(bondGoals));
  }, [bondGoals]);

  const toggleStudent = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const updateGiftCount = (giftId: number, value: string) => {
    const num = Math.max(0, parseInt(value, 10) || 0);
    setOwnedCounts((prev) => ({ ...prev, [giftId]: num }));
  };

  const applyScannedCounts = (detected: Record<number, number>, replaceAll: boolean) => {
    setOwnedCounts((prev) => (replaceAll ? detected : { ...prev, ...detected }));
  };

  const updateBondGoal = (studentId: number, goal: BondGoal) => {
    setBondGoals((prev) => ({ ...prev, [studentId]: goal }));
  };

  const consumeGifts = (usedMap: Record<number, number>) => {
    setOwnedCounts((prev) => {
      const next = { ...prev };
      for (const [idStr, used] of Object.entries(usedMap)) {
        const id = Number(idStr);
        next[id] = Math.max(0, (next[id] ?? 0) - used);
      }
      return next;
    });
  };

  const selectedStudents = useMemo(
    () =>
      selectedIds
        .map((id) => students.find((s) => s.id === id))
        .filter((s): s is Student => Boolean(s)),
    [students, selectedIds]
  );

  const filteredStudents = useMemo(() => {
    return students.filter((s) => {
      if (!includeJp && !s.isReleasedKr) return false;
      if (searchQuery.trim() && !s.name.includes(searchQuery.trim())) return false;
      return true;
    });
  }, [students, includeJp, searchQuery]);

  const analyzedGifts = useMemo(
    () => analyzeGiftsForStudents(selectedStudents, gifts, ownedCounts),
    [selectedStudents, gifts, ownedCounts]
  );

  const displayedGifts = useMemo(() => {
    if (filterMode === 'craftable') {
      return analyzedGifts.filter((g) => g.isSafeToCraft);
    }
    if (filterMode === 'preferred') {
      return analyzedGifts
        .filter((g) => g.studentDetails.some((d) => d.matchCount > 0))
        .sort((a, b) => {
          const maxA = Math.max(...a.studentDetails.map((d) => d.expGain));
          const maxB = Math.max(...b.studentDetails.map((d) => d.expGain));
          return maxB - maxA;
        });
    }
    return analyzedGifts;
  }, [analyzedGifts, filterMode]);

  const craftableOwnedTotal = useMemo(
    () =>
      analyzedGifts
        .filter((g) => g.isSafeToCraft)
        .reduce((acc, cur) => acc + cur.ownedCount, 0),
    [analyzedGifts]
  );

  if (loading) return <div className="status-box">SchaleDB 데이터 불러오는 중...</div>;
  if (error) return <div className="status-box error">{error}</div>;

  return (
    <div className="container">
      <header className="header">
        <h1>블루 아카이브 인연랭 계산기 &amp; 합성 선물 판별기</h1>
        <p>육성할 학생을 선택하고 선물 창 스크린샷을 올리면, 합성해도 되는 선물과 목표 랭크 필요 수량을 자동 계산합니다.</p>
      </header>

      <section className="panel">
        <div className="panel-header">
          <h2>1. 육성할 학생 선택 ({selectedStudents.length}명)</h2>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeJp}
              onChange={(e) => setIncludeJp(e.target.checked)}
            />
            일섭(미래시) 학생 포함
          </label>
        </div>

        {selectedStudents.length > 0 && (
          <>
            <div className="selected-chips">
              {selectedStudents.map((s) => (
                <button
                  key={s.id}
                  className="chip"
                  onClick={() => toggleStudent(s.id)}
                  title="클릭하여 선택 해제"
                >
                  <img src={s.iconUrl} alt={s.name} />
                  <span>{s.name}</span>
                  <span className="remove">×</span>
                </button>
              ))}
            </div>

            <div className="pref-list" style={{ marginBottom: '14px', borderTop: 'none', paddingTop: 0 }}>
              {selectedStudents.map((s) => {
                const topGifts = analyzedGifts
                  .map((a) => ({
                    gift: a.gift,
                    detail: a.studentDetails.find((d) => d.student.id === s.id),
                  }))
                  .filter(
                    (x) =>
                      x.detail &&
                      ((x.gift.rarity === 'SR' && x.detail.expGain >= 60) ||
                        (x.gift.rarity === 'SSR' && x.detail.expGain >= 240))
                  );

                return (
                  <span key={s.id} className="pref-tag high">
                    {s.name} 최고 효율 선물:{' '}
                    {topGifts.length > 0
                      ? topGifts.map((x) => `${x.gift.name}(+${x.detail!.expGain})`).join(', ')
                      : '일반 선호(+40/+180)만 보유'}
                  </span>
                );
              })}
            </div>
          </>
        )}

        <input
          type="text"
          className="search-input"
          placeholder="학생 이름 검색 (예: 미카, 아루, 히나...)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="student-grid">
          {filteredStudents.map((s) => {
            const isSelected = selectedIds.includes(s.id);
            return (
              <button
                key={s.id}
                className={`student-card ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleStudent(s.id)}
              >
                <img src={s.iconUrl} alt={s.name} loading="lazy" />
                <span>{s.name}</span>
              </button>
            );
          })}
        </div>
      </section>

      <nav className="main-tabs">
        <button
          type="button"
          className={`main-tab-btn ${activeTab === 'crafting' ? 'active' : ''}`}
          onClick={() => setActiveTab('crafting')}
        >
          <span>🎁 합성 선물 판별기 &amp; 보유량</span>
          <span className="tab-badge">합성 OK {craftableOwnedTotal}개</span>
        </button>

        <button
          type="button"
          className={`main-tab-btn ${activeTab === 'calculator' ? 'active' : ''}`}
          onClick={() => setActiveTab('calculator')}
        >
          <span>📈 인연 랭크 계산기</span>
          <span className="tab-badge">{selectedStudents.length}명</span>
        </button>
      </nav>

      {activeTab === 'crafting' ? (
        <section className="panel">
          <div className="panel-header">
            <h2>2. 보유 선물 및 합성 추천 분류</h2>
            <div className="filter-tabs">
              <button
                className={filterMode === 'all' ? 'active' : ''}
                onClick={() => setFilterMode('all')}
              >
                전체 ({analyzedGifts.length})
              </button>
              <button
                className={filterMode === 'craftable' ? 'active' : ''}
                onClick={() => setFilterMode('craftable')}
              >
                합성 가능(비선호) ({analyzedGifts.filter((g) => g.isSafeToCraft).length}종 / 보유 {craftableOwnedTotal}개)
              </button>
              <button
                className={filterMode === 'preferred' ? 'active' : ''}
                onClick={() => setFilterMode('preferred')}
              >
                육성 학생 선호 ({analyzedGifts.filter((g) => g.studentDetails.some((d) => d.matchCount > 0)).length})
              </button>
            </div>
          </div>

          <ImageUploader gifts={gifts} onApplyCounts={applyScannedCounts} />

          <div className="gift-grid">
            {displayedGifts.map(({ gift, ownedCount, isSafeToCraft, studentDetails }) => {
              const preferredBy = studentDetails.filter((d) => d.matchCount > 0);
              return (
                <div
                  key={gift.id}
                  className={`gift-card ${isSafeToCraft ? 'craftable' : ''} ${
                    preferredBy.length > 0 ? 'preferred' : ''
                  }`}
                >
                  {isSafeToCraft && <span className="badge craft">합성 OK</span>}
                  {preferredBy.length > 0 && <span className="badge keep">선호 보존</span>}

                  <div className="gift-top">
                    <img
                      src={gift.iconUrl}
                      alt={gift.name}
                      className={`rarity-${gift.rarity.toLowerCase()}`}
                    />
                    <div className="gift-info">
                      <div className="gift-name">{gift.name}</div>
                      <input
                        type="number"
                        min={0}
                        value={ownedCount || ''}
                        placeholder="0"
                        onChange={(e) => updateGiftCount(gift.id, e.target.value)}
                        className="count-input"
                      />
                    </div>
                  </div>

                  {preferredBy.length > 0 && (
                    <div className="pref-list">
                      {preferredBy.map((d) => (
                        <span
                          key={d.student.id}
                          className={`pref-tag ${d.matchCount >= 2 ? 'high' : ''}`}
                        >
                          {d.student.name} (+{d.expGain})
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <BondCalculator
          selectedStudents={selectedStudents}
          gifts={gifts}
          ownedCounts={ownedCounts}
          bondGoals={bondGoals}
          onUpdateGoal={updateBondGoal}
          onConsumeGifts={consumeGifts}
        />
      )}
    </div>
  );
}