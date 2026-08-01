import { describe, expect, it } from "vitest";

import { LocalStateCipher } from "../src/storage/state-cipher.js";
import { TokenService } from "../src/services/token-service.js";
import { InteractionService } from "../src/services/interaction-service.js";
import { MemoryKeyValueStore } from "../src/storage/key-value-store.js";
import { Repositories } from "../src/storage/repositories.js";
import { testConfig } from "./helpers.js";

describe("session and confirmation security", () => {
  it("encrypts browser state with authenticated encryption", async () => {
    const cipher = new LocalStateCipher("correct horse battery staple");
    const encoded = await cipher.encrypt({
      cookies: [{ name: "session", value: "secret" }],
      origins: [],
    });

    expect(encoded).not.toContain("secret");
    await expect(cipher.decrypt(encoded)).resolves.toEqual({
      cookies: [{ name: "session", value: "secret" }],
      origins: [],
    });

    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}`;
    await expect(cipher.decrypt(tampered)).rejects.toThrow();
  });

  it("binds confirmation tokens to principal, reservation, hash, and purpose", async () => {
    const tokens = new TokenService(testConfig());
    const issued = await tokens.issueConfirmation(
      "master@example.com",
      "162c70ff-7074-4a1c-a0d6-709b04a49cc1",
      "summary-hash",
      "reservation_submit",
    );
    const claims = await tokens.verifyConfirmation(issued.token, "reservation_submit");

    expect(claims.sub).toBe("master@example.com");
    expect(claims.summary_hash).toBe("summary-hash");
    await expect(tokens.verifyConfirmation(issued.token, "reservation_cancel")).rejects.toThrow();
  });

  it("delivers browser handoff tokens in the URL fragment, not request query", async () => {
    const config = testConfig();
    const repositories = new Repositories(new MemoryKeyValueStore());
    const service = new InteractionService(config, repositories, new TokenService(config));
    const result = await service.create(
      "master@example.com",
      "login",
      "https://r.gnavi.co.jp/",
    );
    const url = new URL(result.data?.interaction_url as string);

    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#token=/);
    expect(url.pathname).toMatch(/^\/interactions\/[0-9a-f-]{36}$/);
  });
});
