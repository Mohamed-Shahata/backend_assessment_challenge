/**
 * Parses a duration string such as "15m", "7d", "60s", "1h" into whole seconds.
 * Falls back to treating a bare numeric string as seconds.
 */
export function ttlToSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid TTL format: "${value}"`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2] ?? 's';

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 60 * 60 * 24,
  };

  return amount * multipliers[unit];
}
