import { createHash } from "node:crypto";

const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Request-local aliases: reserve valid originals before generating any aliases. */
export function chatToolNameCodec(names: readonly string[]): {
  toWire: (name: string) => string;
  fromWire: (name: string) => string;
} {
  const originals = [...new Set(names)];
  const used = new Set(originals.filter(name => WIRE_NAME.test(name)));
  const encoded = new Map<string, string>();
  const decoded = new Map<string, string>();
  // Sorting also makes collision resolution independent of declaration/history order.
  for (const name of originals.sort()) {
    let wire = name;
    if (!WIRE_NAME.test(name)) {
      const prefix = (name.replace(/[^A-Za-z0-9_-]/g, "_") || "tool").slice(0, 55);
      for (let salt = 0; ; salt++) {
        const input = salt === 0 ? name : `${name}#${salt}`;
        const suffix = createHash("sha256").update(input).digest("hex").slice(0, 8);
        wire = `${prefix}_${suffix}`;
        if (!used.has(wire)) break;
      }
    }
    used.add(wire);
    encoded.set(name, wire);
    decoded.set(wire, name);
  }
  return {
    toWire: name => encoded.get(name) ?? name,
    fromWire: name => decoded.get(name) ?? name,
  };
}

/** Rewrite only Chat function-name fields, never arguments, descriptions or call IDs. */
export function encodeChatToolNames(messages: unknown[], tools: unknown[] | undefined, toolChoice: unknown): (name: string) => string {
  const functions: Record<string, unknown>[] = [];
  const collect = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return;
    const fn = (entry as { function?: unknown }).function;
    if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") {
      functions.push(fn as Record<string, unknown>);
    }
  };
  for (const tool of tools ?? []) collect(tool);
  collect(toolChoice);
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(calls)) for (const call of calls) collect(call);
  }
  const codec = chatToolNameCodec(functions.map(fn => fn.name as string));
  for (const fn of functions) fn.name = codec.toWire(fn.name as string);
  return codec.fromWire;
}
