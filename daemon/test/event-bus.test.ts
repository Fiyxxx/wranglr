import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus";

describe("EventBus", () => {
  test("delivers a published event to a subscriber", () => {
    const bus = new EventBus<{ kind: string }>();
    const received: Array<{ kind: string }> = [];
    bus.subscribe((e) => received.push(e));

    bus.publish({ kind: "hello" });

    expect(received).toEqual([{ kind: "hello" }]);
  });

  test("delivers to multiple subscribers independently", () => {
    const bus = new EventBus<number>();
    const a: number[] = [];
    const b: number[] = [];
    bus.subscribe((n) => a.push(n));
    bus.subscribe((n) => b.push(n));

    bus.publish(1);
    bus.publish(2);

    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test("unsubscribe stops further delivery to that listener only", () => {
    const bus = new EventBus<number>();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = bus.subscribe((n) => a.push(n));
    bus.subscribe((n) => b.push(n));

    bus.publish(1);
    unsubA();
    bus.publish(2);

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
