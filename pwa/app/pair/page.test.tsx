/// <reference lib="dom" />
import { describe, expect, test, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import PairPage from "./page";
import { loadPairing } from "../../lib/pairing";

beforeEach(() => {
  localStorage.clear();
});

describe("PairPage", () => {
  test("saves entered hostname/port/token to pairing storage on submit", () => {
    render(<PairPage />);

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "100.64.1.2" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "7420" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));

    expect(loadPairing()).toEqual({ hostname: "100.64.1.2", port: 7420, token: "secret" });
  });
});
