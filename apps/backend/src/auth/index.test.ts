import assert from "node:assert/strict";
import test from "node:test";
import { errors as joseErrors } from "jose";
import { Hono } from "hono";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import {
  authVerificationTemporarilyUnavailableCode,
  authenticateRequestWithAbortSignalAndDependencies,
  createJwtAuthBoundaryError,
  isTerminalJwtAuthFailure,
  AuthError,
  type AuthenticatedUserIdentity,
} from "./index";
import { resetAuthConfigForTests } from "./config";
import { HttpError } from "../shared/errors";
import type { AppEnv } from "../server/app";
import { createSystemRoutes } from "../routes/system";

test("isTerminalJwtAuthFailure returns true for invalid client tokens", () => {
  assert.equal(isTerminalJwtAuthFailure(new joseErrors.JWTExpired("expired", {})), true);
  assert.equal(isTerminalJwtAuthFailure(new joseErrors.JWSSignatureVerificationFailed()), true);
  // A `kid` absent from the published set is an unusable token rather than a
  // transient lookup failure, which is how the Cognito verifier treated
  // KidNotFoundInJwksError before this replaced it.
  assert.equal(isTerminalJwtAuthFailure(new joseErrors.JWKSNoMatchingKey()), true);
});

test("isTerminalJwtAuthFailure returns false for JWKS fetch and validation failures", () => {
  assert.equal(isTerminalJwtAuthFailure(new joseErrors.JWKSTimeout()), false);
  assert.equal(isTerminalJwtAuthFailure(new joseErrors.JWKSInvalid("jwks invalid")), false);
  assert.equal(isTerminalJwtAuthFailure(new Error("network down")), false);
});

test("isTerminalJwtAuthFailure returns false for unknown errors", () => {
  assert.equal(isTerminalJwtAuthFailure(new Error("unexpected verifier failure")), false);
});

test("createJwtAuthBoundaryError returns retryable 503 for JWKS backoff", () => {
  const error = createJwtAuthBoundaryError(new joseErrors.JWKSTimeout());

  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, authVerificationTemporarilyUnavailableCode);
});

test("GET /me returns 500 when session verification fails with a non-terminal verifier error", async () => {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-1");
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof AuthError) {
      context.status(error.statusCode as ContentfulStatusCode);
      return context.json({
        error: error.message,
        requestId: context.get("requestId"),
        code: "AUTH_UNAUTHORIZED",
      });
    }

    if (error instanceof HttpError) {
      context.status(error.statusCode as ContentfulStatusCode);
      return context.json({
        error: error.message,
        requestId: context.get("requestId"),
        code: error.code,
      });
    }

    context.status(500);
    return context.json({
      error: "Request failed. Try again.",
      requestId: context.get("requestId"),
      code: "INTERNAL_ERROR",
    });
  });
  app.route("/", createSystemRoutes({
    allowedOrigins: [],
    loadRequestContextFromRequestFn: async () => {
      // Non-terminal and not the retryable timeout either, so the boundary
      // classifies it as neither 401 nor 503 and it surfaces as 500.
      throw new joseErrors.JWKSInvalid("jwks invalid");
    },
  }));

  const response = await app.request("http://localhost/me");
  const payload = await response.json() as Readonly<{ code: string }>;

  assert.equal(response.status, 500);
  assert.equal(payload.code, "INTERNAL_ERROR");
});

test("signal-aware authentication aborts in-flight verification before identity mapping", async () => {
  const originalAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "cognito";
  resetAuthConfigForTests();
  const controller = new AbortController();
  const deadlineError = new HttpError(
    503,
    "Media image ingestion cannot safely finish within its request deadline.",
    "MEDIA_ASSET_INGESTION_DEADLINE_EXCEEDED",
    { retryAfterSeconds: 1 },
  );
  let rejectVerification:
  ((reason?: unknown) => void) | undefined;
  const verification = new Promise<AuthenticatedUserIdentity>(
    (_resolve, reject) => {
      rejectVerification = reject;
    },
  );
  let identityMappingCalls = 0;

  try {
    const authentication =
      authenticateRequestWithAbortSignalAndDependencies(
        {
          authorizationHeader: "Bearer pending-token",
          sessionToken: undefined,
        },
        controller.signal,
        {
          authenticateAgentApiKeyFn: async () => {
            throw new Error("Unexpected API-key authentication.");
          },
          authenticateGuestSessionFn: async () => {
            throw new Error("Unexpected guest authentication.");
          },
          loadCognitoIdentityMappingFn: async () => {
            identityMappingCalls += 1;
            return null;
          },
          verifyIdTokenFn: () => verification,
        },
      );

    controller.abort(deadlineError);
    await assert.rejects(authentication, (error: unknown) => {
      assert.equal(error, deadlineError);
      return true;
    });

    rejectVerification?.(new Error("Late verifier rejection."));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(identityMappingCalls, 0);
  } finally {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
    resetAuthConfigForTests();
  }
});
