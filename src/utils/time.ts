export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00:00.00";
  }
  const totalMs = Math.round(seconds * 1000);
  const cs = Math.floor((totalMs % 1000) / 10);
  const totalSecs = Math.floor(totalMs / 1000);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hrs = Math.floor(totalSecs / 3600);

  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function formatTimeShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }
  const totalSecs = Math.floor(seconds);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hrs = Math.floor(totalSecs / 3600);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function parseTimecode(raw: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    const val = Number.parseFloat(cleaned);
    return Number.isFinite(val) ? val : null;
  }

  const parts = cleaned.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const nums = parts.map((p) => Number.parseFloat(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (nums.length === 2) {
    return nums[0] * 60 + nums[1];
  }
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

export function parseFlexibleTimestamp(val: unknown): number | null {
  if (typeof val === "number") {
    return Number.isFinite(val) && val >= 0 ? val : null;
  }
  if (typeof val === "string") {
    return parseTimecode(val);
  }
  return null;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatViews(views: number | null | undefined): string {
  if (views == null) return "";
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M vistas`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K vistas`;
  return `${views} vistas`;
}

export function cleanClipTitle(name: string): string {
  if (!name) return "Clip";
  const cleaned = name
    .replace(/^(?:clip\s*#?\d+\s*[-:.]\s*|\d+[\.\-_)\s]+\s*)/i, "")
    .trim();
  return cleaned || "Clip";
}
