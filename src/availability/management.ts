import { clearKeyCooldowns } from "../providers/key-failover";

/** Management adapter: drop key-pool cooldowns after the operator edits keys. */
export function clearKeyPoolCooldowns(providerName?: string): void {
  clearKeyCooldowns(providerName);
}
