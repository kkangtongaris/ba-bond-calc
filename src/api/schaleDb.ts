import type { GiftItem, Student } from '../types/ba';

const BASE_URL = 'https://schaledb.com';

export async function fetchSchaleData(): Promise<{
  students: Student[];
  gifts: GiftItem[];
}> {
  const [studentsRes, itemsRes] = await Promise.all([
    fetch(`${BASE_URL}/data/kr/students.min.json`),
    fetch(`${BASE_URL}/data/kr/items.min.json`),
  ]);

  if (!studentsRes.ok || !itemsRes.ok) {
    throw new Error('SchaleDB 데이터를 불러오는 데 실패했습니다.');
  }

  const rawStudents = await studentsRes.json();
  const rawItems = await itemsRes.json();

  const studentList = Array.isArray(rawStudents)
    ? rawStudents
    : Object.values(rawStudents);

  const students: Student[] = studentList
    .map((s: any) => ({
      id: Number(s.Id),
      name: String(s.Name ?? ''),
      school: String(s.School ?? ''),
      isReleasedKr: Boolean(s.IsReleased?.[1] ?? true),
      favorItemTags: Array.isArray(s.FavorItemTags)
        ? s.FavorItemTags.map(String)
        : [],
      favorItemUnique: Array.isArray(s.FavorItemUniqueTags)
        ? s.FavorItemUniqueTags.map(String)
        : [],
      iconUrl: `${BASE_URL}/images/student/icon/${s.Id}.webp`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  const itemList = Array.isArray(rawItems)
    ? rawItems
    : Object.values(rawItems);

  const gifts: GiftItem[] = itemList
    .filter((item: any) => item.Category === 'Favor')
    .map((item: any) => ({
      id: Number(item.Id),
      name: String(item.Name ?? ''),
      icon: String(item.Icon ?? ''),
      rarity: (item.Rarity ?? 'SR') as GiftItem['rarity'],
      tags: Array.isArray(item.Tags) ? item.Tags.map(String) : [],
      expValue: Number(item.ExpValue ?? (item.Rarity === 'SSR' ? 120 : 20)),
      iconUrl: `${BASE_URL}/images/item/icon/${item.Icon}.webp`,
      isSelectorBox: String(item.Name ?? '').includes('선택'),
    }))
    .sort((a, b) => {
      if (a.rarity !== b.rarity) return a.rarity === 'SR' ? -1 : 1;
      return a.id - b.id;
    });

  return { students, gifts };
}