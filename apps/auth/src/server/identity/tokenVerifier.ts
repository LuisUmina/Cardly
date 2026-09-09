/**
 * Identity token verification for the personal deployment.
 *
 * Replaces `CognitoJwtVerifier` from `aws-jwt-verify`, which only speaks
 * Cognito's JWKS layout and only verifies RSA. Supabase signs with ES256 by
 * default, so this uses `jose`, which covers ES256, RS256 and HS256 alike.
 *
 * A near-identical copy lives at `apps/backend/src/auth/identityTokenVerifier.ts`.
 * The two services are separately deployed containers with their own
 * `package.json`, and the repository already duplicates this way
 * (`secrets.ts`, `db.ts`); importing across the boundary would couple two
 * deployment units to make one file shorter. Change both together.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const IDENTITY_TOKEN_AUDIENCE = "authenticated";

/**
 * Verification outcomes that are a statement about the token itself, as opposed
 * to a failure to reach the keys. Only these should sign a visitor out; the rest
 * are transient and worth retrying.
 *
 * `ERR_JWKS_NO_MATCHING_KEY` sits on this side deliberately: a `kid` absent from
 * the published set is an unusable token, which is how `aws-jwt-verify` treated
 * `KidNotFoundInJwksError` before this replaced it.
 */
const REJECTED_TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let symmetricKey: Uint8Array | undefined;

function getSupabaseUrl(): string {
  const value = process.env.SUPABASE_URL ?? "";
  if (value === "") {
    throw new Error("SUPABASE_URL is not configured");
  }

  return value.replace(/\/+$/, "");
}

function getIssuer(): string {
  return `${getSupabaseUrl()}/auth/v1`;
}

function getSymmetricSecret(): string {
  return process.env.SUPABASE_JWT_SECRET ?? "";
}

function getRemoteJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (remoteJwks !== undefined) {
    return remoteJwks;
  }

  remoteJwks = createRemoteJWKSet(new URL(`${getIssuer()}/.well-known/jwks.json`));
  return remoteJwks;
}

function getSymmetricKey(secret: string): Uint8Array {
  if (symmetricKey !== undefined) {
    return symmetricKey;
  }

  symmetricKey = new TextEncoder().encode(secret);
  return symmetricKey;
}

/**
 * Verifies an identity token and returns its claims.
 *
 * Asymmetric verification through the published JWKS is the intended path,
 * because it keeps no shared signing secret in either service. `SUPABASE_JWT_SECRET`
 * exists only for a project still on legacy HS256 signing keys, and setting it
 * means both services hold a secret that can mint tokens, so prefer migrating
 * the project to asymmetric keys and leaving it unset.
 */
export async function verifyIdentityToken(token: string): Promise<JWTPayload> {
  const issuer = getIssuer();
  const secret = getSymmetricSecret();

  const { payload } = secret === ""
    ? await jwtVerify(token, getRemoteJwks(), {
      issuer,
      audience: IDENTITY_TOKEN_AUDIENCE,
    })
    : await jwtVerify(token, getSymmetricKey(secret), {
      issuer,
      audience: IDENTITY_TOKEN_AUDIENCE,
    });

  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    throw new Error("Identity token is missing sub claim");
  }

  return payload;
}

export function isRejectedIdentityToken(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  // Matched on `code` rather than `instanceof`, so a second copy of jose resolved
  // anywhere in the tree cannot silently turn a rejection into a transient error.
  const code = error.code;
  return typeof code === "string" && REJECTED_TOKEN_ERROR_CODES.has(code);
}

export function resetIdentityTokenVerifierForTests(): void {
  remoteJwks = undefined;
  symmetricKey = undefined;
}
