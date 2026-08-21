/** Human "in 4m" style countdown for cooldown/cap windows. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "0m";
  const minutes = Math.ceil(msRemaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}u ${rest}m` : `${hours}u`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}u`;
}
