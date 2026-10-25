export interface BanState { failures: number; strikes: number; until: number }
export const BAN_DURATIONS = [60_000, 900_000, 86_400_000, -1] as const;
export function attempt(state: BanState, valid: boolean, now: number): { state: BanState; allowed: boolean; blocked: boolean } {
  if (state.until === -1 || state.until > now) return { state, allowed: false, blocked: true };
  if (valid) return { state: { ...state, failures: 0 }, allowed: true, blocked: false };
  const next = { ...state, failures: state.failures + 1 };
  if (next.failures >= 5) {
    const duration = BAN_DURATIONS[Math.min(next.strikes, 3)];
    next.strikes += 1;
    next.failures = 0;
    next.until = duration === -1 ? -1 : now + duration;
  }
  return { state: next, allowed: false, blocked: next.until === -1 || next.until > now };
}
export function validSecret(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length >= 10 && value.length <= 4096;
}
