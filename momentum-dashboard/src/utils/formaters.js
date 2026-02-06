export function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return `${(x * 100).toFixed(1)}%`;
}


export function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function toNumMaybe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

export const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
};