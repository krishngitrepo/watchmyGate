/**
 * The delivery state machine.
 *
 * Pure, so it is tested directly rather than through the database. The value here is not
 * that the happy path works — it is that the *impossible* paths stay impossible. A
 * parcel that can return to `at_gate` after being marked `returned` makes every timeline
 * built on this table meaningless, and that regression is silent.
 */

import { describe, expect, it } from "vitest";

import { canTransition, type DeliveryStatus } from "./deliveries.service.js";

const TERMINAL: DeliveryStatus[] = ["delivered", "collected", "returned", "refused"];

const ALL: DeliveryStatus[] = [
  "at_gate",
  "awaiting_resident",
  "held_at_gate",
  "out_for_doorstep",
  "delivered",
  "collected",
  "returned",
  "refused",
];

describe("delivery transitions", () => {
  it("walks the ordinary doorstep path", () => {
    expect(canTransition("at_gate", "awaiting_resident")).toBe(true);
    expect(canTransition("awaiting_resident", "out_for_doorstep")).toBe(true);
    expect(canTransition("out_for_doorstep", "delivered")).toBe(true);
  });

  it("walks the collect-at-gate path", () => {
    expect(canTransition("at_gate", "held_at_gate")).toBe(true);
    expect(canTransition("held_at_gate", "collected")).toBe(true);
  });

  it.each(TERMINAL)("%s is terminal — nothing follows it", (status) => {
    for (const to of ALL) {
      expect(canTransition(status, to)).toBe(false);
    }
  });

  it("cannot resurrect a returned parcel", () => {
    expect(canTransition("returned", "at_gate")).toBe(false);
    expect(canTransition("returned", "delivered")).toBe(false);
  });

  it("cannot deliver something that never left the gate", () => {
    // Doorstep delivery has to pass through out_for_doorstep, so the log always shows
    // that someone carried it up.
    expect(canTransition("at_gate", "delivered")).toBe(false);
    expect(canTransition("awaiting_resident", "delivered")).toBe(false);
  });

  it("lets a doorstep attempt come back to the gate", () => {
    // Nobody answered the door. This has to be expressible or guards will mark it
    // delivered to close the row, which is the exact falsehood the table exists to stop.
    expect(canTransition("out_for_doorstep", "held_at_gate")).toBe(true);
  });

  it("never lets a status transition to itself", () => {
    for (const s of ALL) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});
