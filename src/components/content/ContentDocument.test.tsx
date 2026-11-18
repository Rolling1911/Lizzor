// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentDocument } from "./ContentDocument";

describe("ContentDocument", () => {
  afterEach(() => cleanup());
  it("renders structured nodes and marks without HTML injection", () => {
    render(<ContentDocument body={{ type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Welcome" }] },
      { type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }, { type: "text", text: " ", }, { type: "text", text: "safe", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }] }] },
    ] }} />);
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "safe" }).getAttribute("href")).toBe("https://example.com");
    expect(screen.getByRole("list")).toBeTruthy();
  });

  it("does not create unsafe links", () => {
    render(<ContentDocument body={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "unsafe", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] }} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("unsafe")).toBeTruthy();
  });
});