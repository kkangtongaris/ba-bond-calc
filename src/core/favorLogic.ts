import type {
  BondGoal,
  GiftAllocation,
  GiftAnalysis,
  GiftItem,
  GiftUsageMode,
  Student,
  StudentBondPlan,
} from '../types/ba';

export function isUniquePreferredGift(student: Student, gift: GiftItem): boolean {
  if (student.favorItemUnique.length === 0) return false;

  const uniqueSet = new Set(student.favorItemUnique.map((v) => v.trim()));
  return (
    uniqueSet.has(String(gift.id)) ||
    uniqueSet.has(gift.icon) ||
    gift.tags.some((tag) => uniqueSet.has(tag.trim()))
  );
}

export function getMatchCount(student: Student, gift: GiftItem): number {
  const allPrefTags = new Set([
    ...student.favorItemTags.map((v) => v.trim()),
    ...student.favorItemUnique.map((v) => v.trim()),
  ]);

  let count = 0;
  for (const tag of gift.tags) {
    if (allPrefTags.has(tag.trim())) {
      count++;
    }
  }

  return count;
}

export function calculateGiftExp(gift: GiftItem, matchCount: number): number {
  if (gift.rarity === 'SSR') {
    return 120 + Math.min(matchCount, 2) * 60;
  }
  return 20 + Math.min(matchCount, 3) * 20;
}

export function analyzeGiftsForStudents(
  selectedStudents: Student[],
  allGifts: GiftItem[],
  ownedCounts: Record<number, number>
): GiftAnalysis[] {
  return allGifts.map((gift) => {
    const ownedCount = ownedCounts[gift.id] ?? 0;

    const studentDetails = selectedStudents.map((student) => {
      const matchCount = getMatchCount(student, gift);
      return {
        student,
        matchCount,
        expGain: calculateGiftExp(gift, matchCount),
      };
    });

    const isSafeToCraft =
      selectedStudents.length > 0 &&
      gift.rarity === 'SR' &&
      !gift.isSelectorBox &&
      studentDetails.every((d) => d.matchCount === 0);

    return {
      gift,
      ownedCount,
      isSafeToCraft,
      studentDetails,
    };
  });
}

const RANK_UP_EXP = [
  0,
  // 1 ~ 10
  15, 30, 45, 60, 75, 90, 105, 120, 135, 150,
  // 11 ~ 19
  155, 160, 165, 170, 175, 180, 185, 190, 195,
  // 20 ~ 29
  200, 225, 250, 275, 300, 325, 350, 375, 400, 425,
  // 30 ~ 39
  475, 525, 575, 625, 675, 725, 775, 825, 875, 925,
  // 40 ~ 49
  1080, 1210, 1340, 1470, 1600, 1730, 1860, 1990, 2120, 2250,
  // 50 ~ 59
  2320, 2360, 2400, 2440, 2480, 2520, 2560, 2600, 2640, 2680,
  // 60 ~ 69
  2760, 2825, 2890, 2955, 3020, 3085, 3150, 3215, 3280, 3345,
  // 70 ~ 79
  3413, 3483, 3553, 3623, 3693, 3763, 3833, 3903, 3973, 4043,
  // 80 ~ 89
  4225, 4375, 4525, 4675, 4825, 4975, 5125, 5275, 5425, 5575,
  // 90 ~ 99
  5912, 6137, 6362, 6587, 6812, 7037, 7262, 7487, 7712, 7937,
];

export function getExpForNextRank(rank: number): number {
  if (rank < 1) return 15;
  if (rank >= 100) return 0;
  return RANK_UP_EXP[Math.floor(rank)] ?? 0;
}

export function getRequiredExpBetweenRanks(
  currentRank: number,
  targetRank: number
): number {
  const start = Math.max(1, Math.min(100, Math.floor(currentRank)));
  const end = Math.max(1, Math.min(100, Math.floor(targetRank)));
  if (end <= start) return 0;

  let total = 0;
  for (let r = start; r < end; r++) {
    total += getExpForNextRank(r);
  }
  return total;
}

export function simulateReachedRank(currentRank: number, gainedExp: number): number {
  let rank = Math.max(1, Math.min(100, Math.floor(currentRank)));
  let remain = gainedExp;

  while (rank < 100) {
    const need = getExpForNextRank(rank);
    if (remain >= need) {
      remain -= need;
      rank++;
    } else {
      break;
    }
  }
  return rank;
}

export function calculateBondPlans(
  selectedStudents: Student[],
  allGifts: GiftItem[],
  ownedCounts: Record<number, number>,
  bondGoals: Record<number, BondGoal>,
  usageMode: GiftUsageMode
): StudentBondPlan[] {
  const remainingStock: Record<number, number> = { ...ownedCounts };

  // 선택한 학생 중 누구도 선호하지 않는 합성용(비선호) 2성 선물 목록
  const craftablePoolGifts = allGifts.filter(
    (g) =>
      g.rarity === 'SR' &&
      !g.isSelectorBox &&
      selectedStudents.every((s) => getMatchCount(s, g) === 0)
  );

  return selectedStudents.map((student) => {
    const goal = bondGoals[student.id] ?? { currentRank: 1, targetRank: 20 };
    const currentRank = Math.max(1, Math.min(99, goal.currentRank));
    const targetRank = Math.max(currentRank + 1, Math.min(100, goal.targetRank));
    const requiredExp = getRequiredExpBetweenRanks(currentRank, targetRank);

    // 1단계: 보유 중인 선호 선물(matchCount >= 1)부터 효율 순으로 투입
    const preferredCandidates = allGifts
      .filter((gift) => !gift.isSelectorBox && (remainingStock[gift.id] ?? 0) > 0)
      .map((gift) => {
        const matchCount = getMatchCount(student, gift);
        const expPerItem = calculateGiftExp(gift, matchCount);
        return { gift, matchCount, expPerItem };
      })
      .filter((c) => c.matchCount >= 1)
      .sort((a, b) => {
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
        return b.expPerItem - a.expPerItem;
      });

    let needed = requiredExp;
    const allocatedGifts: GiftAllocation[] = [];
    const consumedMap: Record<number, number> = {};

    for (const cand of preferredCandidates) {
      if (needed <= 0) break;
      const available = remainingStock[cand.gift.id] ?? 0;
      if (available <= 0) continue;

      const countToUse = Math.min(available, Math.ceil(needed / cand.expPerItem));
      if (countToUse > 0) {
        const totalExp = countToUse * cand.expPerItem;
        allocatedGifts.push({
          gift: cand.gift,
          useCount: countToUse,
          expPerItem: cand.expPerItem,
          totalExp,
          matchCount: cand.matchCount,
        });
        remainingStock[cand.gift.id] = available - countToUse;
        consumedMap[cand.gift.id] = (consumedMap[cand.gift.id] ?? 0) + countToUse;
        needed -= totalExp;
      }
    }

    // 2단계-A: 비선호 선물을 합성 없이 전부(2★ +20, 3★ +120) 직접 투입하는 모드
    if (needed > 0 && usageMode === 'include_neutral') {
      const neutralCandidates = allGifts
        .filter((gift) => !gift.isSelectorBox && (remainingStock[gift.id] ?? 0) > 0)
        .map((gift) => {
          const matchCount = getMatchCount(student, gift);
          const expPerItem = calculateGiftExp(gift, matchCount);
          return { gift, matchCount, expPerItem };
        })
        .filter((c) => c.matchCount === 0)
        .sort((a, b) => b.expPerItem - a.expPerItem);

      for (const cand of neutralCandidates) {
        if (needed <= 0) break;
        const available = remainingStock[cand.gift.id] ?? 0;
        if (available <= 0) continue;

        const countToUse = Math.min(available, Math.ceil(needed / cand.expPerItem));
        if (countToUse > 0) {
          const totalExp = countToUse * cand.expPerItem;
          allocatedGifts.push({
            gift: cand.gift,
            useCount: countToUse,
            expPerItem: cand.expPerItem,
            totalExp,
            matchCount: 0,
          });
          remainingStock[cand.gift.id] = available - countToUse;
          consumedMap[cand.gift.id] = (consumedMap[cand.gift.id] ?? 0) + countToUse;
          needed -= totalExp;
        }
      }
    }

    // 2단계-B: 비선호 3성(고급 +120) 선물을 직접 투입하는 모드
    if (
      needed > 0 &&
      (usageMode === 'include_ssr_neutral' || usageMode === 'synthesize_and_ssr')
    ) {
      const neutralSsrCandidates = allGifts
        .filter(
          (gift) =>
            gift.rarity === 'SSR' &&
            !gift.isSelectorBox &&
            (remainingStock[gift.id] ?? 0) > 0
        )
        .map((gift) => {
          const matchCount = getMatchCount(student, gift);
          const expPerItem = calculateGiftExp(gift, matchCount);
          return { gift, matchCount, expPerItem };
        })
        .filter((c) => c.matchCount === 0)
        .sort((a, b) => b.expPerItem - a.expPerItem);

      for (const cand of neutralSsrCandidates) {
        if (needed <= 0) break;
        const available = remainingStock[cand.gift.id] ?? 0;
        if (available <= 0) continue;

        const countToUse = Math.min(available, Math.ceil(needed / cand.expPerItem));
        if (countToUse > 0) {
          const totalExp = countToUse * cand.expPerItem;
          allocatedGifts.push({
            gift: cand.gift,
            useCount: countToUse,
            expPerItem: cand.expPerItem,
            totalExp,
            matchCount: 0,
          });
          remainingStock[cand.gift.id] = available - countToUse;
          consumedMap[cand.gift.id] = (consumedMap[cand.gift.id] ?? 0) + countToUse;
          needed -= totalExp;
        }
      }
    }

    // 2단계-C: 비선호 2성 선물을 2:1 합성(선택 상자)해 최고 효율 2성 선호 선물로 투입하는 모드
    if (
      needed > 0 &&
      (usageMode === 'synthesize_neutral' || usageMode === 'synthesize_and_ssr')
    ) {
      const bestSrGiftEntry = allGifts
        .filter((g) => g.rarity === 'SR' && !g.isSelectorBox)
        .map((gift) => {
          const matchCount = getMatchCount(student, gift);
          return {
            gift,
            matchCount,
            expPerItem: calculateGiftExp(gift, matchCount),
          };
        })
        .sort((a, b) => b.expPerItem - a.expPerItem)[0];

      if (bestSrGiftEntry) {
        const availableMaterials = craftablePoolGifts.reduce(
          (sum, g) => sum + (remainingStock[g.id] ?? 0),
          0
        );
        const maxCraftableBoxes = Math.floor(availableMaterials / 2);

        if (maxCraftableBoxes > 0) {
          const boxesToUse = Math.min(
            maxCraftableBoxes,
            Math.ceil(needed / bestSrGiftEntry.expPerItem)
          );

          if (boxesToUse > 0) {
            let materialsToDeduct = boxesToUse * 2;
            const sortedPool = [...craftablePoolGifts].sort(
              (a, b) => (remainingStock[b.id] ?? 0) - (remainingStock[a.id] ?? 0)
            );

            for (const mat of sortedPool) {
              if (materialsToDeduct <= 0) break;
              const stock = remainingStock[mat.id] ?? 0;
              if (stock <= 0) continue;

              const take = Math.min(stock, materialsToDeduct);
              remainingStock[mat.id] = stock - take;
              consumedMap[mat.id] = (consumedMap[mat.id] ?? 0) + take;
              materialsToDeduct -= take;
            }

            const totalExp = boxesToUse * bestSrGiftEntry.expPerItem;
            allocatedGifts.push({
              gift: bestSrGiftEntry.gift,
              useCount: boxesToUse,
              expPerItem: bestSrGiftEntry.expPerItem,
              totalExp,
              matchCount: bestSrGiftEntry.matchCount,
              isSynthesized: true,
              synthesizedMaterialCount: boxesToUse * 2,
            });
            needed -= totalExp;
          }
        }
      }
    }
    
    const gainedExp = allocatedGifts.reduce((sum, item) => sum + item.totalExp, 0);
    const shortageExp = Math.max(0, requiredExp - gainedExp);
    const estimatedRank = simulateReachedRank(currentRank, gainedExp);

    return {
      student,
      currentRank,
      targetRank,
      requiredExp,
      allocatedGifts,
      consumedMap,
      gainedExp,
      shortageExp,
      estimatedRank,
    };
  });
}