import { describe, it, expect, beforeEach } from "vitest";
import { DefaultAuth, NoAuth } from "../src/auth.js";
import type { Agent } from "../src/types.js";

const mockAgent: Agent = {
  id: "agent-1",
  tenantId: "company-1",
  name: "Test Agent",
  adapterType: "claude_local",
  adapterConfig: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("DefaultAuth", () => {
  let auth: DefaultAuth;

  beforeEach(() => {
    auth = new DefaultAuth({ secret: "test-secret-key-for-jwt" });
  });

  it("creates a valid JWT token", () => {
    const token = auth.createToken(mockAgent, "run-1");
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");

    // JWT has 3 parts
    const parts = token!.split(".");
    expect(parts).toHaveLength(3);
  });

  it("verifies a valid token", () => {
    const token = auth.createToken(mockAgent, "run-1")!;
    const claims = auth.verifyToken(token);

    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("agent-1");
    expect(claims!.tenant_id).toBe("company-1");
    expect(claims!.adapter_type).toBe("claude_local");
    expect(claims!.run_id).toBe("run-1");
    expect(claims!.iss).toBe("agent-orchestrator");
    expect(claims!.aud).toBe("agent-orchestrator-api");
  });

  it("rejects a tampered token", () => {
    const token = auth.createToken(mockAgent, "run-1")!;
    const tampered = token.slice(0, -1) + "X";
    expect(auth.verifyToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const otherAuth = new DefaultAuth({ secret: "different-secret" });
    const token = auth.createToken(mockAgent, "run-1")!;
    expect(otherAuth.verifyToken(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const shortLivedAuth = new DefaultAuth({
      secret: "test-secret",
      ttlSeconds: -1, // already expired
    });
    const token = shortLivedAuth.createToken(mockAgent, "run-1")!;
    expect(shortLivedAuth.verifyToken(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(auth.verifyToken("")).toBeNull();
    expect(auth.verifyToken("not.a.jwt")).toBeNull();
    expect(auth.verifyToken("one.two")).toBeNull();
    expect(auth.verifyToken("a.b.c.d")).toBeNull();
  });

  it("returns null token when secret is empty", () => {
    const noSecretAuth = new DefaultAuth({ secret: "" });
    expect(noSecretAuth.createToken(mockAgent, "run-1")).toBeNull();
  });

  it("supports custom issuer and audience", () => {
    const customAuth = new DefaultAuth({
      secret: "test",
      issuer: "my-app",
      audience: "my-api",
    });
    const token = customAuth.createToken(mockAgent, "run-1")!;
    const claims = customAuth.verifyToken(token);
    expect(claims!.iss).toBe("my-app");
    expect(claims!.aud).toBe("my-api");
  });

  it("rejects token with wrong issuer", () => {
    const auth1 = new DefaultAuth({ secret: "test", issuer: "app-1" });
    const auth2 = new DefaultAuth({ secret: "test", issuer: "app-2" });
    const token = auth1.createToken(mockAgent, "run-1")!;
    expect(auth2.verifyToken(token)).toBeNull();
  });
});

describe("NoAuth", () => {
  it("createToken always returns null", () => {
    const noAuth = new NoAuth();
    expect(noAuth.createToken(mockAgent, "run-1")).toBeNull();
  });

  it("verifyToken always returns null", () => {
    const noAuth = new NoAuth();
    expect(noAuth.verifyToken("any-token")).toBeNull();
  });
});
