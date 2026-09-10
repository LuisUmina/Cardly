/**
 * HTTP surface for the chat live SSE stream, for a container deployment.
 *
 * Upstream serves this from a Lambda Function URL using
 * `awslambda.streamifyResponse` (`entrypoints/lambda-chat-live.ts`), which has no
 * meaning outside Lambda. The orchestration itself is portable: `runLiveStream`
 * writes to a plain Node `Writable`, and `handleLiveRequest` reads a URL and
 * headers, so only the transport had to be rebuilt.
 *
 * This is not optional the way it first looked. `assertRunningLiveStreamInvariant`
 * in `chat/http/envelopes.ts` refuses to build a conversation envelope for a
 * running run without a live stream, so with `CHAT_LIVE_URL` unset every chat
 * request fails with `CHAT_RESUME_CONTRACT_VIOLATION` — the run is accepted and
 * then immediately interrupted. The design assumes that if a run is executing,
 * the client has somewhere to attach.
 */
import { PassThrough, Readable } from "node:stream";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { handleLiveRequest } from "../chat/live/request";
import { runLiveStream } from "../chat/live";
import { HttpError } from "../shared/errors";
import {
  captureBackendException,
  createBackendObservationScope,
  normalizeCaughtError,
} from "../observability/sentry";

/** Path this app serves. `CHAT_LIVE_URL` must point at it. */
export const chatLivePath = "/chat-live";

/**
 * Headers that keep an SSE response flowing through intermediaries.
 *
 * `no-transform` and `X-Accel-Buffering: no` exist because a proxy that buffers
 * turns a live stream into one delivery at the end, which looks to the user like
 * the assistant thinking in silence and then answering all at once.
 */
const chatLiveResponseHeaders: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export function createChatLiveApp(): Hono {
  const app = new Hono();

  app.get(chatLivePath, async (context) => {
    const params = await handleLiveRequest(
      new URL(context.req.url),
      context.req.header("authorization"),
      context.req.raw.headers,
    );

    const stream = new PassThrough();
    // Detached on purpose: the response has to be returned now so bytes can start
    // flowing, and the orchestration keeps writing to the stream until the run
    // ends or the client disconnects.
    void runLiveStream(stream, params)
      .catch((error: unknown) => {
        captureBackendException({
          action: "request_failed",
          error: normalizeCaughtError(error),
          scope: createBackendObservationScope(
            "chat-live",
            params.requestId ?? null,
            chatLivePath,
            "GET",
            params.userId,
            params.workspaceId,
            params.clientRequestId ?? null,
            params.runId,
            params.sessionId,
            params.clientVersion ?? null,
            params.clientPlatform ?? null,
          ),
          details: {
            statusCode: 500,
            code: "CHAT_LIVE_STREAM_FAILED",
            message: normalizeCaughtError(error).message,
            validationIssues: [],
          },
        });
      })
      .finally(() => {
        stream.end();
      });

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: chatLiveResponseHeaders,
    });
  });

  // Failures from `handleLiveRequest` happen before any byte is written, so they
  // are ordinary HTTP errors rather than in-band SSE ones.
  app.onError((error, context) => {
    if (error instanceof HttpError) {
      return context.json(
        { error: error.message, code: error.code },
        error.statusCode as ContentfulStatusCode,
      );
    }

    return context.json({ error: "Internal Server Error", code: "INTERNAL_ERROR" }, 500);
  });

  return app;
}
