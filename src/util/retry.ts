// Exponential backoff with jitter, capped.
export function nextBackoff(attempt: number, minMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, minMs * 2 ** attempt);
  const jitter = exp * (0.5 + Math.random() * 0.5); // 50%-100% of exp
  return Math.min(maxMs, Math.floor(jitter));
}
