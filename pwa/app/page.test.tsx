/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import Home from "./page";

describe("Home", () => {
  test("renders the app name", () => {
    render(<Home />);
    expect(screen.getByText("Wranglr")).toBeTruthy();
  });
});
