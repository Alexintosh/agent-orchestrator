import type { Agent } from "../types.js";

export interface TokenClaims {
  sub: string;
  tenant_id: string;
  adapter_type: string;
  run_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
}

/**
 * Pluggable authentication provider for agent runs.
 * Generates short-lived JWT tokens that agents can use to call back into APIs.
 */
export interface AuthProvider {
  createToken(agent: Agent, runId: string): string | null;
  verifyToken(token: string): TokenClaims | null;
}
