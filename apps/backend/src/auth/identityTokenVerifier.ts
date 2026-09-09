/**
 * Identity token verification for the personal deployment.
 *
 * Replaces `CognitoJwtVerifier` from `aws-jwt-verify`, which only speaks
 * Cognito's JWKS layout and only verifies RSA. Supabase signs with ES256 by
 * default, so this uses `jose`, which covers ES256, RS256 and HS256 alike.
 *
 * A near-identical copy lives at `apps/auth/src/server/identity/tokenVerifier.ts`.
 * The two services are separately deployed containers with their own
 * `package.json`, and the repository already duplicates this way
 * (`secrets.ts`, `db.ts`); importing across the boundary would couple two
 * deployment units to make one file shorter. Change both together.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

const IDENTITY_TOKEN_AUDIENCE = "authenticated";

/**
 * Verification outcomes that are a statement about the token itself, as opposed
 * to a failure to reach the keys. Only these should reject a request outright;
 * the rest are transient and are surfaced as "verification temporarily
 * unavailable" so a caller retries instead of being signed out.
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

/**
 * Carries a request's deadline into the JWKS fetch.
 *
 * `jwtVerify` takes no abort signal, and the key fetch is the only network call
 * on the authentication path, so a request that has already given up would
 * otherwise keep waiting on it. Async-local storage is how the previous
 * `aws-jwt-verify` wiring solved the same problem, and keeping that shape means
 * the calling code in `auth/index.ts` does not change.
 */
const jwksFetchAbortSignalStorage = new AsyncLocalStorage<AbortSignal>();

export function runWithIdentityJwksAbortSignal<Result>(
  abortSignal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  return jwksFetchAbortSignalStorage.run(abortSignal, operation);
}

function getSupabaseUrl(): string {
  const value = process.env.SUPABASE_URL ?? "";
  if (value === "") {
    throw new Error("SUPABASE_URL is required when AUTH_MODE=cognito");
  }

  return value.replace(/\/+$/, "");
}

export function getIdentityIssuer(): string {
  return `${getSupabaseUrl()}/auth/v1`;
}

function getSymmetricSecret(): string {
  return process.env.SUPABASE_JWT_SECRET ?? "";
}

function getRemoteJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (remoteJwks !== undefined) {
    return remoteJwks;
  }

  remoteJwks = createRemoteJWKSet(
    new URL(`${getIdentityIssuer()}/.well-known/jwks.json`),
    {
      [customFetch]: async (url, options) => {
        const requestAbortSignal = jwksFetchAbortSignalStorage.getStore();
        // jose already supplies its own timeout signal; the request deadline is
        // added to it rather than replacing it, so whichever fires first wins.
        const signal = requestAbortSignal === undefined
          ? options.signal
          : AbortSignal.any([options.signal, requestAbortSignal]);
        return fetch(url, { ...options, signal });
      },
    },
  );
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
 * because it keeps no shared signing secret in either service.
 * `SUPABASE_JWT_SECRET` exists only for a project still on legacy HS256 signing
 * keys, and setting it means both services hold a secret that can mint tokens,
 * so prefer migrating the project to asymmetric keys and leaving it unset.
 */
export async function verifyIdentityToken(token: string): Promise<JWTPayload> {
  const secret = getSymmetricSecret();
  const options = {
    issuer: getIdentityIssuer(),
    audience: IDENTITY_TOKEN_AUDIENCE,
  };

  const { payload } = secret === ""
    ? await jwtVerify(token, getRemoteJwks(), options)
    : await jwtVerify(token, getSymmetricKey(secret), options);

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
