export const GALLERY_SIZE = 10;
export const FEATURED_SIZE = 3;
export const COLUMN_SIZE = 3;
export function fixedSlots(ids, count) {
  return Array.from({ length: Math.max(count, ids.length) }, (_, index) => ids[index] || null);
}
export function completeSlots(slots, count) {
  return slots.length === count && slots.every(Boolean) && new Set(slots).size === count;
}
export function galleryPosition(index) {
  return index < 10 ? `第${index < 5 ? "一" : "二"}排 · 第${index % 5 + 1}张` : "超出画廊位置";
}
export const columnPositions = [
  { desktop: "左上小图", mobile: "下方左图" },
  { desktop: "左下小图", mobile: "下方右图" },
  { desktop: "右侧大图", mobile: "上方大图" },
];
export function mergeSite(value, patch) {
  // Each screen edits one part of the existing full-site contract.
  return { ...value, ...patch };
}
