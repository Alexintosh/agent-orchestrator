import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "../src/events.js";

describe("EventEmitter", () => {
  it("emits events to registered listeners", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();

    emitter.on("run.started", listener);
    emitter.emit("run.started", { id: "run-1" } as any);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ id: "run-1" });
  });

  it("supports multiple listeners for the same event", () => {
    const emitter = new EventEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on("run.completed", listener1);
    emitter.on("run.completed", listener2);
    emitter.emit("run.completed", { id: "run-1" } as any);

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("does not call listeners for different events", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();

    emitter.on("run.started", listener);
    emitter.emit("run.completed", { id: "run-1" } as any);

    expect(listener).not.toHaveBeenCalled();
  });

  it("removes a listener with off()", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();

    emitter.on("run.started", listener);
    emitter.off("run.started", listener);
    emitter.emit("run.started", { id: "run-1" } as any);

    expect(listener).not.toHaveBeenCalled();
  });

  it("swallows listener errors", () => {
    const emitter = new EventEmitter();
    const thrower = vi.fn(() => {
      throw new Error("listener error");
    });
    const healthy = vi.fn();

    emitter.on("run.started", thrower);
    emitter.on("run.started", healthy);

    // Should not throw
    expect(() => emitter.emit("run.started", { id: "run-1" } as any)).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("handles emit with no listeners gracefully", () => {
    const emitter = new EventEmitter();
    expect(() => emitter.emit("run.started", { id: "run-1" } as any)).not.toThrow();
  });

  it("passes multiple arguments to listeners", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();

    emitter.on("session.rotated", listener);
    emitter.emit("session.rotated", "agent-1", "task-1", "too many runs");

    expect(listener).toHaveBeenCalledWith("agent-1", "task-1", "too many runs");
  });
});
