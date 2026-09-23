import { createHash } from "node:crypto";
import { CalDavError } from "./caldav.js";

export type ActionNotice = {
  /** Deterministic for this exact intended write, not a globally unique run ID. */
  id: string;
  operation: "create" | "update" | "delete";
  pair: string;
  side: string;
  href: string;
  etag: string | null;
  /** Private event content, when available. Never forward blindly to public logs. */
  ics?: string;
  internal: boolean;
  consolidationId?: string;
};
export type ActionOutcome = ActionNotice & { status: "completed" | "skipped" | "failed" | "uncertain" };
export type ActionHooks = {
  /** Awaited before a write. Throw to veto and stop execution. Receives a detached copy. */
  beforeAction?: (action: ActionNotice) => void | Promise<void>;
  /** Awaited after a write attempt. Throw to stop; completed writes stay completed. */
  onAction?: (action: ActionOutcome) => void | Promise<void>;
};
export class ActionObserverError extends Error {
  constructor(
    readonly phase: "before" | "after",
    readonly action: ActionNotice | ActionOutcome,
  ) {
    super(`Action observer failed ${phase} the write`);
    this.name = "ActionObserverError";
  }
}
export function actionNotice(input: Omit<ActionNotice, "id">): ActionNotice {
  return { ...input, id: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
}

/** Internal execution primitive; callbacks never mutate the operation being executed. */
export async function performAction(
  action: ActionNotice,
  write: () => Promise<void | "skipped">,
  options: ActionHooks & { signal?: AbortSignal },
): Promise<ActionOutcome["status"]> {
  options.signal?.throwIfAborted();
  try {
    await options.beforeAction?.(structuredClone(action));
  } catch {
    throw new ActionObserverError("before", structuredClone(action));
  }
  options.signal?.throwIfAborted();
  let failure: unknown;
  let failed = false;
  let status: ActionOutcome["status"] = "completed";
  try {
    if ((await write()) === "skipped") status = "skipped";
  } catch (error) {
    failed = true;
    failure = error;
    // Transport failures, timeouts and server errors can happen after a committed write.
    status =
      error instanceof CalDavError && error.status >= 400 && error.status < 500 && error.status !== 408
        ? "failed"
        : "uncertain";
  }
  const outcome = { ...action, status };
  try {
    await options.onAction?.(structuredClone(outcome));
  } catch {
    throw new ActionObserverError("after", structuredClone(outcome));
  }
  if (failed) throw failure;
  return status;
}
