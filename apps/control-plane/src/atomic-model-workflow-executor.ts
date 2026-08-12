import { setTimeout as delay } from "node:timers/promises";
import type { AtomicRpcClient, AtomicRpcNativeEvent, AtomicRpcResponse } from "./atomic-rpc-client.ts";
import {
  ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME,
  buildAtomicFixtureModelWorkflowDispatchCommand,
  buildAtomicWorkflowStatusCommand,
  isTerminalAtomicWorkflowStatus,
  parseAtomicFixtureModelWorkflowOutput,
  parseAtomicWorkflowLifecycleEvent,
  parseAtomicWorkflowListEvent,
  type AtomicFixtureModelWorkflowInputs,
  type AtomicFixtureModelWorkflowOutput,
  type AtomicWorkflowLifecycleDetail,
} from "./atomic-workflow-protocol.ts";

export interface AtomicModelWorkflowExecution {
  nativeSessionId: string;
  nativeWorkflowRunId: string;
  nativeCursor: string | null;
  output: AtomicFixtureModelWorkflowOutput;
  rawRecords: Array<AtomicRpcResponse | AtomicRpcNativeEvent>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function remaining(deadline: number, cap = 30_000): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("Atomic model workflow exceeded its elapsed-time bound");
  return Math.max(25, Math.min(value, cap));
}

function waitFor<T>(
  client: AtomicRpcClient,
  parse: (value: unknown) => T | null,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): { promise: Promise<T>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  let listener: (value: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    listener = (value) => {
      try {
        const parsed = parse(value);
        if (parsed && predicate(parsed)) {
          clearTimeout(timer);
          client.off("event", listener);
          resolve(parsed);
        }
      } catch (error) {
        clearTimeout(timer);
        client.off("event", listener);
        reject(error);
      }
    };
    client.on("event", listener);
    timer = setTimeout(() => {
      client.off("event", listener);
      reject(new Error("Atomic model workflow native event timed out"));
    }, timeoutMs);
    timer.unref();
  });
  return { promise, cancel: () => { clearTimeout(timer); client.off("event", listener); } };
}

async function paired<T>(waiter: ReturnType<typeof waitFor<T>>, command: Promise<unknown>): Promise<T> {
  try { return (await Promise.all([waiter.promise, command]))[0]; }
  catch (error) { waiter.cancel(); await waiter.promise.catch(() => undefined); throw error; }
}

/** Executes only the fixed model workflow. It performs no artifact or approval action. */
export async function executeAtomicFixtureModelWorkflow(input: {
  client: AtomicRpcClient;
  inputs: AtomicFixtureModelWorkflowInputs;
  signal: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  onRecord?: (record: AtomicRpcResponse | AtomicRpcNativeEvent, ordinal: number) => Promise<void> | void;
}): Promise<AtomicModelWorkflowExecution> {
  const timeoutMs = input.timeoutMs ?? 240_000;
  const pollMs = input.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 240_000) throw new Error("Atomic model timeout is invalid");
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 5_000) throw new Error("Atomic model poll interval is invalid");
  const deadline = Date.now() + timeoutMs;
  const rawRecords: AtomicModelWorkflowExecution["rawRecords"] = [];
  let recordOrdinal = 0;
  let recordChain = Promise.resolve();
  const unsubscribe = input.client.subscribeRecords((record) => {
    rawRecords.push(record);
    const ordinal = ++recordOrdinal;
    if (input.onRecord) recordChain = recordChain.then(() => input.onRecord!(record, ordinal));
  });
  try {
    const state = object((await input.client.getState({ signal: input.signal, timeoutMs: remaining(deadline) })).data, "Atomic state");
    if (typeof state.sessionId !== "string" || !state.sessionId) throw new Error("Atomic model workflow has no native main session ID");
    const commands = await input.client.getCommands({ signal: input.signal, timeoutMs: remaining(deadline) });
    if (!JSON.stringify(commands.data).includes("workflow") || !JSON.stringify(commands.data).includes("atomic-routing")) {
      throw new Error("Atomic model workflow package commands were not discovered");
    }
    const listWait = waitFor(input.client, parseAtomicWorkflowListEvent, () => true, remaining(deadline, 10_000));
    const listed = await paired(listWait, input.client.prompt("/workflow list", { signal: input.signal, timeoutMs: remaining(deadline, 10_000) }));
    if (!listed.workflows.includes(ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME)) throw new Error("Atomic model fixture workflow was not discovered");
    const dispatch = buildAtomicFixtureModelWorkflowDispatchCommand(input.inputs);
    const admittedWait = waitFor(input.client, parseAtomicWorkflowLifecycleEvent,
      (value) => value.action === "run" && value.workflow === ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME,
      remaining(deadline, 15_000));
    const admitted = await paired(admittedWait, input.client.prompt(dispatch, { signal: input.signal, timeoutMs: remaining(deadline, 15_000) }));
    if (admitted.status !== "running" && admitted.status !== "pending") throw new Error("Atomic model workflow was not admitted");
    let terminal: AtomicWorkflowLifecycleDetail | undefined;
    while (!terminal) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error("Atomic model workflow cancelled");
      const statusWait = waitFor(input.client, parseAtomicWorkflowLifecycleEvent,
        (value) => value.action === "status" && value.runId === admitted.runId,
        remaining(deadline, 15_000));
      const status = await paired(statusWait, input.client.prompt(buildAtomicWorkflowStatusCommand(admitted.runId), {
        signal: input.signal, timeoutMs: remaining(deadline, 15_000),
      }));
      if (isTerminalAtomicWorkflowStatus(status.status)) terminal = status;
      else await delay(Math.min(pollMs, remaining(deadline)), undefined, { signal: input.signal });
    }
    if (terminal.status !== "completed") throw new Error(`Atomic model workflow ended ${terminal.status}`);
    const output = parseAtomicFixtureModelWorkflowOutput(terminal.output);
    const entries = object((await input.client.getEntries(undefined, { signal: input.signal, timeoutMs: remaining(deadline) })).data, "Atomic entries");
    await recordChain;
    return {
      nativeSessionId: state.sessionId,
      nativeWorkflowRunId: terminal.runId,
      nativeCursor: typeof entries.leafId === "string" ? entries.leafId : null,
      output,
      rawRecords,
    };
  } finally {
    unsubscribe();
    await recordChain;
  }
}
