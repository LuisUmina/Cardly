/**
 * Backend-owned chat worker dispatch helpers.
 * The route layer persists the run first, then this module triggers the worker so the run survives client disconnects.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  captureBackendException,
  createBackendObservationScope,
  getBackendTraceCarrier,
  normalizeCaughtError,
  type BackendExceptionEvent,
  type BackendTraceCarrier,
} from "../../observability/sentry";
import { markQueuedChatRunDispatchFailed } from "../runs";
import { HttpError } from "../../shared/errors";

export type ChatWorkerDispatch = Readonly<{
  runId: string;
  userId: string;
  workspaceId: string;
  initiatingAuthIsSignedIn: boolean;
  routeRequestId?: string | null;
  chatRequestId?: string | null;
  sessionId?: string | null;
}>;

export type ChatWorkerInvocation = Readonly<{
  runId: string;
  userId: string;
  workspaceId: string;
  initiatingAuthIsSignedIn?: boolean;
  routeRequestId?: string | null;
  chatRequestId?: string | null;
  sessionId?: string | null;
  traceContext: BackendTraceCarrier | null;
}>;

type ChatWorkerInvocationDependencies = Readonly<{
  getTraceCarrier: () => BackendTraceCarrier | null;
  getFunctionName: () => string;
  sendCommand: (command: InvokeCommand) => Promise<void>;
}>;

type ChatWorkerDispatchFailureDependencies = Readonly<{
  invokeWorker: (payload: ChatWorkerDispatch) => Promise<void>;
  markDispatchFailed: (
    userId: string,
    workspaceId: string,
    runId: string,
    errorMessage: string,
  ) => Promise<void>;
  captureException: (event: BackendExceptionEvent) => void;
}>;

let lambdaClient: LambdaClient | null = null;

/**
 * Returns the process-local Lambda client used to trigger chat workers.
 */
function getLambdaClient(): LambdaClient {
  if (lambdaClient === null) {
    lambdaClient = new LambdaClient({});
  }

  return lambdaClient;
}

/**
 * Reads the Lambda function name that owns backend-owned chat execution, or
 * `null` when there is no Lambda to invoke.
 *
 * Unset selects in-process execution. On Lambda the route and the worker have to
 * be separate functions, because the route's response ends its invocation and
 * would kill the run with it. A long-lived container has no such boundary: the
 * process outlives the response, so the run can simply continue in it. That is
 * strictly simpler than the queue it replaces, and it is why this is a fallback
 * rather than a rewrite — the reference AWS deployment sets the variable and
 * keeps its detached worker untouched.
 */
function getChatWorkerFunctionName(): string | null {
  const functionName = process.env.CHAT_WORKER_FUNCTION_NAME;
  if (functionName === undefined || functionName === "") {
    return null;
  }

  return functionName;
}

/**
 * The deadline handed to an in-process run.
 *
 * On Lambda this reports the invocation's real remaining time and the run winds
 * down before being killed mid-flight. A container has no such limit, so this is
 * a plain upper bound that keeps a wedged run from holding resources forever.
 */
const inProcessChatWorkerBudgetMs = 15 * 60 * 1000;

/**
 * Starts a persisted run in this process without waiting for it.
 *
 * Dispatch is deliberately fire-and-forget, matching `InvocationType: "Event"`:
 * the HTTP route returns as soon as the run is queued, and the client follows
 * progress through `GET /v1/chat`. Failures inside the run are the worker's own
 * to record, so the only thing caught here is a rejection that would otherwise
 * surface as an unhandled promise and take the process down.
 */
async function dispatchChatWorkerInProcess(
  invocation: ChatWorkerInvocation,
): Promise<void> {
  const startedAtMs = Date.now();
  const { handleChatWorkerEvent } = await import("./index");

  void handleChatWorkerEvent(invocation, {
    lambdaRequestId: null,
    getRemainingTimeInMillis: (): number =>
      Math.max(0, inProcessChatWorkerBudgetMs - (Date.now() - startedAtMs)),
  }).catch((error: unknown) => {
    const normalizedError = normalizeCaughtError(error);
    const isHttpError = normalizedError instanceof HttpError;
    captureBackendException({
      action: "chat_worker_failed",
      error: normalizedError,
      scope: createBackendObservationScope(
        "chat-worker",
        invocation.routeRequestId ?? null,
        null,
        null,
        invocation.userId,
        invocation.workspaceId,
        invocation.chatRequestId ?? null,
        invocation.runId,
        invocation.sessionId ?? null,
        null,
        null,
      ),
      // Mirrors createChatWorkerFailureDetails in entrypoints/lambda-chat-worker.ts,
      // so an in-process failure is reported in the same shape as a Lambda one.
      details: {
        lambdaRequestId: null,
        routeRequestId: invocation.routeRequestId ?? null,
        chatRequestId: invocation.chatRequestId ?? null,
        runId: invocation.runId,
        sessionId: invocation.sessionId ?? null,
        userId: invocation.userId,
        workspaceId: invocation.workspaceId,
        statusCode: isHttpError ? normalizedError.statusCode : null,
        code: isHttpError ? normalizedError.code : null,
        message: normalizedError.message,
      },
    });
  });
}

function createChatWorkerInvocation(
  payload: ChatWorkerDispatch,
  traceContext: BackendTraceCarrier | null,
): ChatWorkerInvocation {
  return {
    runId: payload.runId,
    userId: payload.userId,
    workspaceId: payload.workspaceId,
    initiatingAuthIsSignedIn: payload.initiatingAuthIsSignedIn,
    routeRequestId: payload.routeRequestId ?? null,
    chatRequestId: payload.chatRequestId ?? null,
    sessionId: payload.sessionId ?? null,
    traceContext: traceContext === null
      ? null
      : {
        sentryTrace: traceContext.sentryTrace,
        baggage: traceContext.baggage,
      },
  };
}

function createChatWorkerInvokeCommand(
  functionName: string,
  invocation: ChatWorkerInvocation,
): InvokeCommand {
  return new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: new TextEncoder().encode(JSON.stringify(invocation)),
  });
}

export async function invokeChatWorkerWithDependencies(
  payload: ChatWorkerDispatch,
  dependencies: ChatWorkerInvocationDependencies,
): Promise<void> {
  const invocation = createChatWorkerInvocation(payload, dependencies.getTraceCarrier());
  const command = createChatWorkerInvokeCommand(dependencies.getFunctionName(), invocation);
  await dependencies.sendCommand(command);
}

/**
 * Dispatches a persisted chat run to the asynchronous worker without waiting for completion.
 */
export async function invokeChatWorker(
  payload: ChatWorkerDispatch,
): Promise<void> {
  const functionName = getChatWorkerFunctionName();
  if (functionName === null) {
    await dispatchChatWorkerInProcess(
      createChatWorkerInvocation(payload, getBackendTraceCarrier()),
    );
    return;
  }

  await invokeChatWorkerWithDependencies(payload, {
    getTraceCarrier: getBackendTraceCarrier,
    getFunctionName: (): string => functionName,
    sendCommand: async (command: InvokeCommand): Promise<void> => {
      await getLambdaClient().send(command);
    },
  });
}

function createChatWorkerDispatchFailedEvent(
  payload: ChatWorkerDispatch,
  error: Error,
  message: string,
): BackendExceptionEvent {
  return {
    action: "chat_worker_dispatch_failed",
    error,
    scope: createBackendObservationScope(
      "backend-api",
      payload.routeRequestId ?? null,
      null,
      null,
      payload.userId,
      payload.workspaceId,
      payload.chatRequestId ?? null,
      payload.runId,
      payload.sessionId ?? null,
      null,
      null,
    ),
    details: {
      message,
    },
  };
}

function createDispatchPersistenceFailureError(
  dispatchError: Error,
  markError: Error,
): Error {
  const error = new Error(
    `Chat worker dispatch failed before failed-state persistence failed: ${dispatchError.message}`,
    { cause: markError },
  );
  error.name = "ChatWorkerDispatchPersistenceFailureError";
  return error;
}

export async function invokeChatWorkerOrPersistFailureWithDependencies(
  payload: ChatWorkerDispatch,
  dependencies: ChatWorkerDispatchFailureDependencies,
): Promise<void> {
  try {
    await dependencies.invokeWorker(payload);
  } catch (error) {
    const dispatchError = normalizeCaughtError(error);
    const message = dispatchError.message;
    dependencies.captureException(createChatWorkerDispatchFailedEvent(payload, dispatchError, message));
    try {
      await dependencies.markDispatchFailed(
        payload.userId,
        payload.workspaceId,
        payload.runId,
        `Chat worker dispatch failed: ${message}`,
      );
    } catch (markError) {
      throw createDispatchPersistenceFailureError(dispatchError, normalizeCaughtError(markError));
    }
    throw dispatchError;
  }
}

/**
 * Dispatches a persisted chat run and marks it as failed if worker invocation itself fails.
 */
export async function invokeChatWorkerOrPersistFailure(
  payload: ChatWorkerDispatch,
): Promise<void> {
  await invokeChatWorkerOrPersistFailureWithDependencies(payload, {
    invokeWorker: invokeChatWorker,
    markDispatchFailed: markQueuedChatRunDispatchFailed,
    captureException: captureBackendException,
  });
}
