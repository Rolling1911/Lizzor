// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDrawer, AdminTabs, ConfirmationDialog, DataTable } from "./AdminPrimitives";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("admin table and overlay primitives", () => {
  it("labels every DataTable cell, including the first cell, and opts into responsive cards explicitly", () => {
    render(<DataTable columns={[{ key: "name", label: "Name" }, { key: "state", label: "State" }]} rows={[{ id: "one", name: "One", state: "Ready" }]} />);
    const table = screen.getByRole("table");
    expect(table.classList.contains("admin-table--responsive")).toBe(true);
    expect(table.parentElement?.classList.contains("admin-table-wrap--responsive")).toBe(true);
    expect(within(table).getAllByRole("cell").map((cell) => cell.getAttribute("data-label"))).toEqual(["Name", "State"]);
  });

  it("does not opt handwritten tables into the responsive card conversion", () => {
    render(<div className="admin-table-wrap"><table className="admin-table"><tbody><tr><td>Meaningful first cell</td><td data-label="Status">Ready</td></tr></tbody></table></div>);
    const table = screen.getByRole("table");
    expect(table.classList.contains("admin-table--responsive")).toBe(false);
    expect(table.parentElement?.classList.contains("admin-table-wrap--responsive")).toBe(false);
  });

  it("provides roving tab focus for keyboard navigation", () => {
    const onChange = vi.fn();
    render(<AdminTabs tabs={[{ value: "one", label: "One" }, { value: "two", label: "Two" }, { value: "three", label: "Three" }]} value="one" onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("two");
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(onChange).toHaveBeenCalledWith("three");
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("one");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("contains ConfirmationDialog focus, handles Escape, and restores the trigger", () => {
    const cancel = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const view = render(<ConfirmationDialog open title="Confirm" description="Please confirm" onConfirm={vi.fn()} onCancel={cancel} />);
    const dialog = screen.getByRole("dialog");
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    const confirmButton = within(dialog).getByRole("button", { name: "Confirm" });
    expect(document.activeElement).toBe(confirmButton);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmButton);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
    view.rerender(<ConfirmationDialog open={false} title="Confirm" description="Please confirm" onConfirm={vi.fn()} onCancel={cancel} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("locks body scroll, traps AdminDrawer focus, and restores the trigger", () => {
    const close = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const view = render(<AdminDrawer open title="Details" onClose={close}><button type="button">Action</button></AdminDrawer>);
    const drawer = screen.getByRole("dialog");
    const closeButton = within(drawer).getByRole("button", { name: "Close panel" });
    const actionButton = within(drawer).getByRole("button", { name: "Action" });
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(actionButton);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    view.rerender(<AdminDrawer open={false} title="Details" onClose={close}><button type="button">Action</button></AdminDrawer>);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});