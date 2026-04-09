/** Truncate string to max length with suffix */
export function truncate(s: string, max: number, suffix = '...'): string {
  if (s.length <= max) return s;
  return s.slice(0, max - suffix.length) + suffix;
}

/** Truncate preserving start and end (for file paths etc.) */
export function truncateMiddle(s: string, max: number, separator = '...'): string {
  if (s.length <= max) return s;
  const startLen = Math.floor((max - separator.length) / 2);
  const endLen = max - separator.length - startLen;
  return s.slice(0, startLen) + separator + s.slice(-endLen);
}