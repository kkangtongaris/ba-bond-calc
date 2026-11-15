export interface Student {
  id: number;
  name: string;
  school: string;
  isReleasedKr: boolean;
  favorItemTags: string[];
  favorItemUnique: string[];
  iconUrl: string;
}

export interface GiftItem {
  id: number;
  name: string;
  icon: string;
  rarity: 'N' | 'R' | 'SR' | 'SSR';
  tags: string[];
  expValue: number;
  iconUrl: string;
  isSelectorBox: boolean;
}

export interface GiftAnalysis {
  gift: GiftItem;
  ownedCount: number;
  isSafeToCraft: boolean;
  studentDetails: {
    student: Student;
    matchCount: number;
    expGain: number;
  }[];
}

export interface BondGoal {
  currentRank: number;
  targetRank: number;
}

export type GiftUsageMode =
  | 'preferred_only'
  | 'include_neutral'
  | 'synthesize_neutral';

export interface GiftAllocation {
  gift: GiftItem;
  useCount: number;
  expPerItem: number;
  totalExp: number;
  matchCount: number;
  isSynthesized?: boolean;
  synthesizedMaterialCount?: number;
}

export interface StudentBondPlan {
  student: Student;
  currentRank: number;
  targetRank: number;
  requiredExp: number;
  allocatedGifts: GiftAllocation[];
  consumedMap: Record<number, number>;
  gainedExp: number;
  shortageExp: number;
  estimatedRank: number;
}