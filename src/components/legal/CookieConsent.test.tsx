// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CookieConsent, cookieConsentAllows, readCookiePreferences } from "./CookieConsent";

beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe("CookieConsent", () => {
  it("shows a compact first-visit banner and rejects non-essential storage", async () => {
    render(<CookieConsent />);
    expect(await screen.findByRole("heading", { name: "Your privacy choices" })).toBeTruthy();
    expect(screen.queryByLabelText("Analytics")).toBeNull();
    expect(screen.getByRole("button", { name: "Manage preferences" })).toBeTruthy();
    expect(screen.getByLabelText("Cookie Policy is not yet published")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject non-essential" }));
    expect(readCookiePreferences()).toEqual({ version: 1, essential: true, analytics: false, marketing: false });
    expect(cookieConsentAllows("essential")).toBe(true);
    expect(cookieConsentAllows("analytics")).toBe(false);
    expect(cookieConsentAllows("marketing")).toBe(false);
  });
  it("manages optional switches, accepts all, persists, and reopens from the footer event", async () => {
    render(<CookieConsent />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage preferences" }));
    expect((screen.getByRole("switch", { name: "Essential cookies, always on" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Analytics"));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(cookieConsentAllows("analytics")).toBe(true);
    expect(cookieConsentAllows("marketing")).toBe(false);
    window.dispatchEvent(new Event("lizzor:open-cookie-settings"));
    fireEvent.click(await screen.findByLabelText("Marketing"));
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(cookieConsentAllows("analytics")).toBe(true);
    expect(cookieConsentAllows("marketing")).toBe(true);
    window.dispatchEvent(new Event("lizzor:open-cookie-settings"));
    fireEvent.click(await screen.findByLabelText("Analytics"));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(cookieConsentAllows("analytics")).toBe(false);
    expect(cookieConsentAllows("marketing")).toBe(true);
  });
  it("continues safely when private browsing blocks preference writes", async () => {
    const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "QuotaExceededError"); });
    render(<CookieConsent />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject non-essential" }));
    expect(screen.queryByRole("heading", { name: "Your privacy choices" })).toBeNull();
    expect(cookieConsentAllows("essential")).toBe(true);
    blocked.mockRestore();
  });
});