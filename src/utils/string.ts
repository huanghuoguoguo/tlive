/** Truncate string to max length with suffix */
export function truncate(s: string, max: number, suffix = '...'): string {
  if (s.length <= max) return s;
  return s.slice(0, max - suffix.length) + suffix;
}