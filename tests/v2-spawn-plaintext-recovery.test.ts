import { beforeEach, describe, expect, test } from "bun:test";
import {
  hydrateV2SpawnTaskPlaintext,
  rememberV2SpawnTaskPlaintext,
  resetV2SpawnTaskPlaintextForTests,
} from "../src/server/responses/v2-spawn-plaintext";

function fernetFixture(): string {
  const raw = Buffer.alloc(73, 0x5a);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

const FERNET_TASK = fernetFixture();
const PARENT = "0123456789abcdef0123456789abcdef";
const TASK = "review_pr51";
const PLAINTEXT = "Review PR 51 at exact head and report blockers only.";

function childInput(): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: `/root/${TASK}`,
    content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${TASK}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ],
  }];
}
describe("V2 spawn plaintext recovery", () => {
  beforeEach(() => resetV2SpawnTaskPlaintextForTests());

  test("restores the pre-encryption spawn message into the child task and consumes it", () => {
    expect(rememberV2SpawnTaskPlaintext(PARENT, "spawn_agent", JSON.stringify({
      task_name: TASK,
      message: PLAINTEXT,
    }), 1_000)).toBe(true);

    const input = childInput();
    expect(hydrateV2SpawnTaskPlaintext(input, PARENT, 1_001)).toBe(true);
    expect(JSON.stringify(input)).toContain(PLAINTEXT);
    expect(JSON.stringify(input)).not.toContain(FERNET_TASK);
    expect(hydrateV2SpawnTaskPlaintext(childInput(), PARENT, 1_002)).toBe(false);
  });

  test("does not cache a message that is already backend ciphertext", () => {
    expect(rememberV2SpawnTaskPlaintext(PARENT, "spawn_agent", JSON.stringify({
      task_name: TASK,
      message: FERNET_TASK,
    }), 1_000)).toBe(false);
    expect(hydrateV2SpawnTaskPlaintext(childInput(), PARENT, 1_001)).toBe(false);
  });

  test("expires plaintext instead of retaining it indefinitely", () => {
    expect(rememberV2SpawnTaskPlaintext(PARENT, "spawn_agent", JSON.stringify({
      task_name: TASK,
      message: PLAINTEXT,
    }), 1_000)).toBe(true);
    expect(hydrateV2SpawnTaskPlaintext(childInput(), PARENT, 301_001)).toBe(false);
  });
});
