/** Unit labels for a countdown; injected so the caller supplies locale-correct suffixes. */
export interface CountdownUnits {
  minutes: string;
  hours: string;
  days: string;
}

/** Dutch defaults keep the existing behavior when a caller passes no units. */
const DEFAULT_UNITS: CountdownUnits = { minutes: "m", hours: "u", days: "d" };

/**
 * Human "in 4m" style countdown for cooldown/cap windows. Unit suffixes are injectable
 * so the English UI does not show the Dutch hour abbreviation ("u"); callers pass the
 * translated labels from i18n (ops.unitMinutes/unitHours/unitDays).
 */
export function formatCountdown(msRemaining: number, units: CountdownUnits = DEFAULT_UNITS): string {
  if (msRemaining <= 0) return `0${units.minutes}`;
  const minutes = Math.ceil(msRemaining / 60_000);
  if (minutes < 60) return `${minutes}${units.minutes}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}${units.hours} ${rest}${units.minutes}` : `${hours}${units.hours}`;
  const days = Math.floor(hours / 24);
  return `${days}${units.days} ${hours % 24}${units.hours}`;
}
