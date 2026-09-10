/**
 * Container entrypoint serving the HTTP API and the MCP surface on one port.
 *
 * Upstream splits these across two Lambdas behind two API Gateways, because
 * `mcp.<domain>` is a separate resource with its own OAuth metadata. This
 * deployment has one free-tier container, and a second one would double the cold
 * starts to save nothing, so both apps run in the same process.
 *
 * Dispatch is by exact path rather than by mounting one app inside the other.
 * Both surfaces define `/health`, and the MCP app also mirrors itself under
 * `/v1` for API Gateway's stage prefix, so mounting would leave the winner of
 * `/v1/health` decided by registration order. Naming the two MCP paths outright
 * removes that question: everything else is the API, unconditionally.
 *
 * Replaces `index.ts` as the Docker CMD. `index.ts` is left untouched and stays
 * the upstream local-development entrypoint.
 */
import { serve } from "@hono/node-server";
import { createApp } from "../server/app";
import { mcpApp } from "./lambda-mcp";
import { initializeBackendSentry } from "../observability/sentry";
import { initializeLangfuseTelemetry } from "../telemetry/langfuse";

/** The paths the MCP app owns. Everything else belongs to the HTTP API. */
const mcpTransportPath = "/mcp";
const mcpProtectedResourceMetadataPrefix = "/.well-known/oauth-protected-resource";

function isMcpPath(pathname: string): boolean {
  return pathname === mcpTransportPath
    || pathname.startsWith(mcpProtectedResourceMetadataPrefix);
}

async function main(): Promise<void> {
  initializeBackendSentry("backend-api");
  initializeLangfuseTelemetry();

  const apiApp = createApp("/v1");
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);

  serve({
    fetch: (request: Request, ...rest: ReadonlyArray<unknown>): Response | Promise<Response> => {
      const { pathname } = new URL(request.url);
      const app = isMcpPath(pathname) ? mcpApp : apiApp;
      return app.fetch(request, ...rest);
    },
    port,
  }, (info) => {
    // Handed to `console` as an object rather than pre-serialized, for the same
    // reason index.ts does it: a pre-serialized record leaves `message` a string
    // with nothing inside it addressable.
    console.log({ domain: "backend", action: "start", port: info.port, mcp: true });
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error({ domain: "backend", action: "startup_failed", error: message });
  process.exit(1);
});
