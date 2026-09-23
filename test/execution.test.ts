import { expect, it, vi } from "vitest";
import { actionNotice, performAction, ActionObserverError } from "../src/execution.js";
import { CalDavError } from "../src/caldav.js";
const notice = () =>
  actionNotice({
    operation: "create",
    pair: "pair",
    side: "a",
    href: "https://example.com/event",
    etag: null,
    internal: false,
    ics: "private",
  });
it("awaits a detached pre-write notice and reports completed only after the write", async () => {
  const order: string[] = [];
  const n = notice();
  await performAction(
    n,
    async () => {
      order.push("write");
    },
    {
      beforeAction: async (copy) => {
        await Promise.resolve();
        copy.href = "modified";
        order.push("before");
      },
      onAction: async (outcome) => {
        expect(outcome.href).toBe(n.href);
        expect(outcome.status).toBe("completed");
        order.push("after");
      },
    },
  );
  expect(order).toEqual(["before", "write", "after"]);
  expect(notice().id).toBe(n.id);
});
it("vetoes before IO without leaking observer exceptions", async () => {
  const write = vi.fn();
  await expect(
    performAction(notice(), write, {
      beforeAction: () => {
        throw new Error("secret");
      },
    }),
  ).rejects.toMatchObject({
    name: "ActionObserverError",
    phase: "before",
    message: "Action observer failed before the write",
  });
  expect(write).not.toHaveBeenCalled();
});
it("preserves a successful write if its completion observer fails", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  await expect(
    performAction(notice(), write, {
      onAction: () => {
        throw new Error("secret");
      },
    }),
  ).rejects.toMatchObject({ phase: "after", action: { status: "completed" } });
  expect(write).toHaveBeenCalledTimes(1);
});
it.each([
  [412, "failed"],
  [503, "uncertain"],
  [408, "uncertain"],
])("classifies HTTP %s without claiming success", async (status, outcome) => {
  const onAction = vi.fn();
  await expect(
    performAction(
      notice(),
      async () => {
        throw new CalDavError(Number(status), "PUT", notice().href, "private");
      },
      { onAction },
    ),
  ).rejects.toThrow();
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ status: outcome }));
});
it("marks transport failure uncertain and keeps that outcome on observer failure", async () => {
  await expect(
    performAction(
      notice(),
      async () => {
        throw new Error("connection lost");
      },
      {
        onAction: () => {
          throw new Error("log down");
        },
      },
    ),
  ).rejects.toMatchObject({ action: { status: "uncertain" } });
});
it("does not write if aborted while awaiting the before hook", async () => {
  const controller = new AbortController(),
    write = vi.fn(),
    onAction = vi.fn();
  await expect(
    performAction(notice(), write, { signal: controller.signal, beforeAction: () => controller.abort(), onAction }),
  ).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
  expect(onAction).not.toHaveBeenCalled();
  expect(new ActionObserverError("before", notice())).toBeInstanceOf(Error);
});
