import type { AddressInfo } from "node:net";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApplication, type RunningApplication } from "../src/http/app.js";
import { silentLogger, testConfig } from "./helpers.js";

describe("HTTP surface", () => {
  let application: RunningApplication | undefined;

  afterEach(async () => {
    if (application !== undefined) {
      await application.close();
      application = undefined;
    }
  });

  it("serves health and OAuth protected-resource discovery", async () => {
    application = createApplication(testConfig(), silentLogger);
    await listen(application);
    const agent = request(application.server);

    await agent.get("/healthz").expect(200, { status: "ok", service_mode: "all" });
    const metadata = await agent
      .get("/.well-known/oauth-protected-resource/mcp")
      .expect(200);
    expect(metadata.body).toMatchObject({
      resource: "http://localhost:8080/mcp",
      scopes_supported: ["mcp"],
    });
  });

  it("registers public PKCE clients without a client secret", async () => {
    application = createApplication(testConfig(), silentLogger);
    await listen(application);
    const response = await request(application.server)
      .post("/oauth/register")
      .send({
        client_name: "Test MCP Client",
        redirect_uris: ["http://localhost:9876/callback"],
        token_endpoint_auth_method: "none",
      })
      .expect(201);
    const body = response.body as Record<string, unknown>;

    expect(body).toMatchObject({
      client_name: "Test MCP Client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
    });
    expect(body.client_id).toBeTypeOf("string");
    expect(body.client_secret).toBeUndefined();
  });

  it("requires a bearer token unless development bypass is explicit", async () => {
    application = createApplication(testConfig({ authDisabled: false }), silentLogger);
    await listen(application);
    const response = await request(application.server)
      .post("/mcp")
      .set("content-type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);
    expect(response.header["www-authenticate"]).toContain("resource_metadata");
  });

  it("serves a real MCP initialize exchange through the development auth gate", async () => {
    application = createApplication(testConfig({ authDisabled: true }), silentLogger);
    await listen(application);
    const response = await request(application.server)
      .post("/mcp")
      .set("content-type", "application/json")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "contract-test", version: "1.0.0" },
        },
      })
      .expect(200);

    expect(response.type).toBe("text/event-stream");
    expect(response.text).toContain('"jsonrpc":"2.0"');
    expect(response.text).toContain('"name":"gurunavi-concierge"');
    expect(response.text).toContain('"version":"0.1.0"');
  });

  it("publishes the concierge tool contract without browser primitives", async () => {
    application = createApplication(testConfig({ authDisabled: true }), silentLogger);
    await listen(application);
    const response = await request(application.server)
      .post("/mcp")
      .set("content-type", "application/json")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      .expect(200);

    for (const name of [
      "restaurant_search",
      "restaurant_get",
      "reservation_options_get",
      "reservation_prepare",
      "reservation_submit",
      "reservation_status_get",
      "reservation_cancel_prepare",
      "reservation_cancel_submit",
      "browser_session_connect",
      "interaction_resume",
    ]) {
      expect(response.text).toContain(`"name":"${name}"`);
    }
    expect(response.text).toContain('"option_id"');
    expect(response.text).toContain('"slot_id"');
    expect(response.text).not.toContain('"name":"browser_click"');
    expect(response.text).not.toContain('"name":"browser_navigate"');
  });
});

async function listen(application: RunningApplication): Promise<void> {
  await new Promise<void>((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address() as AddressInfo;
  expect(address.port).toBeGreaterThan(0);
}
