import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthProvider, TokenClaims } from "./interfaces/auth.js";
import type { Agent } from "./types.js";

const JWT_ALGORITHM = "HS256";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJsonSafe(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface DefaultAuthOptions {
  secret: string;
  ttlSeconds?: number;
  issuer?: string;
  audience?: string;
}

/**
 * Default HS256 JWT auth provider.
 * Adapted from Paperclip's agent-auth-jwt.ts.
 */
export class DefaultAuth implements AuthProvider {
  private secret: string;
  private ttlSeconds: number;
  private issuer: string;
  private audience: string;

  constructor(opts: DefaultAuthOptions) {
    this.secret = opts.secret;
    this.ttlSeconds = opts.ttlSeconds ?? 60 * 60 * 48; // 48h
    this.issuer = opts.issuer ?? "agent-orchestrator";
    this.audience = opts.audience ?? "agent-orchestrator-api";
  }

  createToken(agent: Agent, runId: string): string | null {
    if (!this.secret) return null;

    const now = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = {
      sub: agent.id,
      tenant_id: agent.tenantId,
      adapter_type: agent.adapterType,
      run_id: runId,
      iat: now,
      exp: now + this.ttlSeconds,
      iss: this.issuer,
      aud: this.audience,
    };

    const header = { alg: JWT_ALGORITHM, typ: "JWT" };
    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
    const signature = signPayload(this.secret, signingInput);

    return `${signingInput}.${signature}`;
  }

  verifyToken(token: string): TokenClaims | null {
    if (!token || !this.secret) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, claimsB64, signature] = parts;

    const header = parseJsonSafe(base64UrlDecode(headerB64!));
    if (!header || header.alg !== JWT_ALGORITHM) return null;

    const signingInput = `${headerB64}.${claimsB64}`;
    const expectedSig = signPayload(this.secret, signingInput);
    if (!safeCompare(signature!, expectedSig)) return null;

    const claims = parseJsonSafe(base64UrlDecode(claimsB64!));
    if (!claims) return null;

    const sub = typeof claims.sub === "string" ? claims.sub : null;
    const tenantId =
      typeof claims.tenant_id === "string" ? claims.tenant_id : null;
    const adapterType =
      typeof claims.adapter_type === "string" ? claims.adapter_type : null;
    const runId = typeof claims.run_id === "string" ? claims.run_id : null;
    const iat = typeof claims.iat === "number" ? claims.iat : null;
    const exp = typeof claims.exp === "number" ? claims.exp : null;
    if (!sub || !tenantId || !adapterType || !runId || !iat || !exp)
      return null;

    const now = Math.floor(Date.now() / 1000);
    if (exp < now) return null;

    const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
    const audience = typeof claims.aud === "string" ? claims.aud : undefined;
    if (issuer && issuer !== this.issuer) return null;
    if (audience && audience !== this.audience) return null;

    return {
      sub,
      tenant_id: tenantId,
      adapter_type: adapterType,
      run_id: runId,
      iat,
      exp,
      ...(issuer ? { iss: issuer } : {}),
      ...(audience ? { aud: audience } : {}),
    };
  }
}

/**
 * No-op auth provider that never generates tokens.
 */
export class NoAuth implements AuthProvider {
  createToken(): string | null {
    return null;
  }
  verifyToken(): TokenClaims | null {
    return null;
  }
}
