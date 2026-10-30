import { describe, expect, test } from "bun:test";
import {
  clickhouseDashboardRow,
  clickhouseLoopbackInsertUrl,
} from "../src/clickhouse";

describe("dashboard ClickHouse client", () => {
  test("accepts a passwordless loopback HTTP URL", () => {
    const url = clickhouseLoopbackInsertUrl("http://127.0.0.1:8123");
    expect(url).toContain("http://127.0.0.1:8123/?query=");
    expect(url).toContain("INSERT");
    expect(url).not.toContain("@");
  });

  test("rejects credentials, https, and non-loopback hosts", () => {
    expect(
      clickhouseLoopbackInsertUrl("http://user:secret@127.0.0.1:8123"),
    ).toBeUndefined();
    expect(
      clickhouseLoopbackInsertUrl("https://127.0.0.1:8123"),
    ).toBeUndefined();
    expect(
      clickhouseLoopbackInsertUrl("http://clickhouse.example.com:8123"),
    ).toBeUndefined();
    expect(clickhouseLoopbackInsertUrl("")).toBeUndefined();
  });

  test("the ready row has no prompt or account fields", () => {
    const row = clickhouseDashboardRow("dashboard_ready");
    expect(row.event).toBe("dashboard_ready");
    expect(row.surface).toBe("dashboard");
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("apiKey");
  });
});
