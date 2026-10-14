/** A single, interruptible Signaal selection grammar for navigation rails. */
export function selectionTransition(
  reducedMotion: boolean | null,
  keyboardNavigation: boolean,
  visualDuration: 0.18 | 0.22,
) {
  if (reducedMotion !== false || keyboardNavigation) return { duration: 0 } as const;
  return { type: "spring", visualDuration, bounce: 0 } as const;
}
