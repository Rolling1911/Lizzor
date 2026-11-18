// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("../../auth/api", () => ({ apiRequest: mocks.apiRequest }));
import { LegalAcceptance, type LegalScope } from "./LegalAcceptance";
const policies = (active = true) => ({ data: { active, b2c: [{ title: "Consumer Terms", publicRoute: "/terms", versionId: "11111111-1111-4111-8111-111111111111" }, { title: "Privacy Policy", publicRoute: "/privacy", versionId: "22222222-2222-4222-8222-222222222222" }], b2b: [{ title: "Business Terms", publicRoute: "/business-terms", versionId: "33333333-3333-4333-8333-333333333333" }, { title: "Privacy Policy", publicRoute: "/privacy", versionId: "22222222-2222-4222-8222-222222222222" }], account: [{ title: "Terms of Use", publicRoute: "/terms", versionId: "44444444-4444-4444-8444-444444444444" }, { title: "Privacy Policy", publicRoute: "/privacy", versionId: "22222222-2222-4222-8222-222222222222" }] } });
function Harness({ scope }: { scope: LegalScope }) { const [value, setValue] = useState<string[]>([]); return <LegalAcceptance scope={scope} value={value} onChange={setValue} />; }
beforeEach(() => mocks.apiRequest.mockResolvedValue(policies()));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("LegalAcceptance", () => {
  it("hides inactive requirements", async () => { mocks.apiRequest.mockResolvedValue(policies(false)); render(<MemoryRouter><Harness scope="b2c" /></MemoryRouter>); await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull()); });
  it("links the active scope and emits only its exact ids after an unprechecked action", async () => {
    render(<MemoryRouter><Harness scope="b2b" /></MemoryRouter>);
    const box = await screen.findByRole("checkbox");
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("link", { name: "Business Terms" }).getAttribute("href")).toBe("/business-terms");
    expect(screen.queryByText(/marketing/i)).toBeNull();
    fireEvent.click(box); expect((box as HTMLInputElement).checked).toBe(true);
  });
  it("clears acknowledgement when the scope changes", async () => {
    const view = render(<MemoryRouter><Harness scope="b2c" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("checkbox"));
    view.rerender(<MemoryRouter><Harness scope="account" /></MemoryRouter>);
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false));
    expect(screen.getByRole("link", { name: "Terms of Use" })).toBeTruthy();
  });
});