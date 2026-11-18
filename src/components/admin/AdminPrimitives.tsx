import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icon, type IconName } from "../ui/Icon";

export function AdminPageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="admin-page__heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="admin-page__heading-actions">{actions}</div>}
    </div>
  );
}

export function KpiCard({ label, value, detail, tone = "default" }: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "accent" | "quiet";
}) {
  return <article className={`admin-kpi admin-kpi--${tone}`}><span className="admin-kpi__label">{label}</span><strong>{value}</strong>{detail && <span className="admin-kpi__detail">{detail}</span>}</article>;
}

export function EmptyState({ title, description, icon = "package" }: { title: string; description: string; icon?: IconName }) {
  return <div className="admin-empty"><div className="admin-empty__icon"><Icon name={icon} size={20} /></div><h3>{title}</h3><p>{description}</p></div>;
}

export function LoadingState({ label = "Loading workspace data…" }: { label?: string }) {
  return <div className="admin-state admin-state--loading" role="status"><span className="admin-spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ title = "Something went wrong", description = "We could not load this workspace. Try again in a moment.", onRetry }: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return <div className="admin-state admin-state--error" role="alert"><strong>{title}</strong><span>{description}</span>{onRetry && <button className="button button--quiet button--small" onClick={onRetry}>Try again</button>}</div>;
}

export function SearchInput({ value, onChange, placeholder = "Search this workspace", onSubmit }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
}) {
  return <form className="admin-search" onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}>
    <Icon name="search" size={16} />
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
    {value && <button type="button" className="admin-search__clear" onClick={() => onChange("")} aria-label="Clear search"><Icon name="x" size={14} /></button>}
  </form>;
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="admin-filter-bar">{children}</div>;
}

export function Pagination({ page, hasNext, onChange }: { page: number; hasNext: boolean; onChange: (page: number) => void }) {
  return <div className="admin-pagination"><span>Page {page}</span><div><button className="button button--quiet button--small" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button><button className="button button--quiet button--small" disabled={!hasNext} onClick={() => onChange(page + 1)}>Next</button></div></div>;
}

export function StatusBadge({ status, tone = "neutral" }: { status: string; tone?: "neutral" | "positive" | "warning" | "negative" }) {
  return <span className={`status-badge status-badge--${tone}`}><span />{status}</span>;
}

export function DataTable<T>({ columns, rows, empty }: {
  columns: Array<{ key: string; label: string; render?: (row: any) => ReactNode }>;
  rows: T[];
  empty?: ReactNode;
}) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing here yet" description="Records will appear when this area is connected to its data source." />}</>;
  return <div className="admin-table-wrap admin-table-wrap--responsive"><table className="admin-table admin-table--responsive"><thead><tr>{columns.map((column) => <th key={String(column.key)} scope="col">{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String((row as Record<string, unknown>)["id"] ?? index)}>{columns.map((column) => <td key={String(column.key)} data-label={column.label}>{column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? "")}</td>)}</tr>)}</tbody></table></div>;
}

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmationDialog({ open, title, description, confirmLabel = "Confirm", confirmDisabled = false, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    (confirmDisabled ? cancelRef.current : confirmRef.current)?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancelRef.current();
      else trapFocus(event);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return <div className="admin-dialog-backdrop" role="presentation" onMouseDown={onCancel}><div ref={dialogRef} className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title" aria-describedby="admin-dialog-description" onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">Confirmation</span><h2 id="admin-dialog-title">{title}</h2><p id="admin-dialog-description">{description}</p><div className="admin-dialog__actions"><button type="button" ref={cancelRef} className="button button--quiet" onClick={onCancel}>Cancel</button><button type="button" ref={confirmRef} className="button button--dark" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button></div></div></div>;
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="admin-form-section"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{children}</section>;
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="admin-form-actions">{children}</div>;
}

export function DateRangeSelector({ value, onChange, customStart, customEnd, onCustomStartChange, onCustomEndChange }: {
  value: string;
  onChange: (value: string) => void;
  customStart?: string;
  customEnd?: string;
  onCustomStartChange?: (value: string) => void;
  onCustomEndChange?: (value: string) => void;
}) {
  const options = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 Days"], ["30d", "30 Days"], ["month", "This Month"], ["previousMonth", "Previous Month"], ["year", "This Year"], ["custom", "Custom Range"]];
  return <div className="date-range-wrap"><div className="date-range" role="group" aria-label="Dashboard date range">{options.map(([key, label]) => <button type="button" key={key} className={value === key ? "is-active" : ""} onClick={() => onChange(key)} aria-pressed={value === key}>{label}</button>)}</div>
    {value === "custom" && <div className="date-range__custom">
      <label>Start date<input type="date" value={customStart} max={customEnd} onChange={(event) => onCustomStartChange?.(event.target.value)} /></label>
      <label>End date<input type="date" value={customEnd} min={customStart} onChange={(event) => onCustomEndChange?.(event.target.value)} /></label>
    </div>}
  </div>;
}

export function ChartContainer({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <section className="admin-panel admin-chart"><div className="admin-panel__heading"><div><span className="eyebrow">Trend</span><h2>{title}</h2></div>{detail && <span className="section-note">{detail}</span>}</div>{children}</section>;
}

export function BulkActionBar({ selectedCount, children }: { selectedCount: number; children?: ReactNode }) {
  return selectedCount > 0 ? <div className="admin-bulk-bar"><strong>{selectedCount} selected</strong>{children}</div> : null;
}

export function PermissionGate({ allowed, children, fallback }: { allowed: boolean; children: ReactNode; fallback?: ReactNode }) {
  return allowed ? <>{children}</> : <>{fallback ?? null}</>;
}

/** Shared structural primitives for admin modules. These intentionally stay presentation-only. */
export function AdminBreadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return <nav className="admin-breadcrumbs" aria-label="Breadcrumb">
    {items.map((item, index) => <span key={`${item.label}-${index}`} className="admin-breadcrumbs__item">
      {index > 0 && <Icon name="arrow-right" size={13} />}
      {item.href ? <a href={item.href}>{item.label}</a> : <span aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>}
    </span>)}
  </nav>;
}

export function AdminActionGroup({ children }: { children: ReactNode }) {
  return <div className="admin-action-group">{children}</div>;
}

export function AdminPanel({ title, eyebrow, description, actions, children, className = "" }: {
  title?: string; eyebrow?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`admin-panel admin-panel--system ${className}`}>
    {(title || eyebrow || actions) && <div className="admin-panel__heading">
      <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>
      {actions && <AdminActionGroup>{actions}</AdminActionGroup>}
    </div>}
    {children}
  </section>;
}

export function AdminNotice({ tone = "info", title, children }: { tone?: "info" | "success" | "warning" | "error"; title?: string; children: ReactNode }) {
  return <div className={`admin-notice admin-notice--${tone}`} role={tone === "error" ? "alert" : "status"}><Icon name={tone === "success" ? "check" : tone === "warning" ? "mail-warning" : tone === "error" ? "x" : "circle-help"} size={17} /><div>{title && <strong>{title}</strong>}<span>{children}</span></div></div>;
}

export function AdminTabs({ tabs, value, onChange, label = "Section navigation", className = "" }: {
  tabs: Array<{ value: string; label: string; count?: number; disabled?: boolean }>; value: string; onChange: (value: string) => void; label?: string; className?: string;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusTab = (index: number) => {
    const enabled = tabs.map((tab, tabIndex) => ({ tab, tabIndex })).filter(({ tab }) => !tab.disabled);
    const next = enabled[index];
    if (!next) return;
    onChange(next.tab.value);
    tabRefs.current[next.tabIndex]?.focus();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const enabledIndexes = tabs.map((tab, tabIndex) => !tab.disabled ? tabIndex : -1).filter((tabIndex) => tabIndex >= 0);
    const position = enabledIndexes.indexOf(index);
    if (position < 0) return;
    let nextPosition = position;
    if (event.key === "ArrowRight") nextPosition = (position + 1) % enabledIndexes.length;
    else if (event.key === "ArrowLeft") nextPosition = (position - 1 + enabledIndexes.length) % enabledIndexes.length;
    else if (event.key === "Home") nextPosition = 0;
    else if (event.key === "End") nextPosition = enabledIndexes.length - 1;
    else return;
    event.preventDefault();
    focusTab(nextPosition);
  };
  return <div className={`admin-tabs${className ? ` ${className}` : ""}`} role="tablist" aria-label={label}>{tabs.map((tab, index) => <button id={`admin-tab-${tab.value}`} key={tab.value} ref={(element) => { tabRefs.current[index] = element; }} type="button" role="tab" aria-controls={`admin-tabpanel-${tab.value}`} aria-selected={value === tab.value} tabIndex={value === tab.value ? 0 : -1} disabled={tab.disabled} className={value === tab.value ? "is-active" : ""} onKeyDown={(event) => handleKeyDown(event, index)} onClick={() => onChange(tab.value)}>{tab.label}{tab.count != null && <span>{tab.count}</span>}</button>)}</div>;
}

export function AdminField({ label, htmlFor, required, optional, hint, error, children }: {
  label: string; htmlFor?: string; required?: boolean; optional?: boolean; hint?: string; error?: string; children: ReactNode;
}) {
  return <div className={`admin-field${error ? " has-error" : ""}`}><label htmlFor={htmlFor}>{label} {required && <span aria-hidden="true">*</span>}{optional && <small>Optional</small>}</label>{children}{hint && !error && <span className="admin-field__hint">{hint}</span>}{error && <span className="admin-field__error" role="alert">{error}</span>}</div>;
}

export function AdminFormGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <fieldset className="admin-form-group"><legend>{title}</legend>{description && <p>{description}</p>}<div className="admin-form-group__fields">{children}</div></fieldset>;
}

export function ReadOnlyState({ title = "Read-only access", description = "Your role can view this information but cannot change it." }: { title?: string; description?: string }) {
  return <AdminNotice tone="info" title={title}>{description}</AdminNotice>;
}

export function LoadingSkeleton({ rows = 4, columns = 3 }: { rows?: number; columns?: number }) {
  return <div className="admin-skeleton" role="status" aria-label="Loading"><span className="sr-only">Loading</span>{Array.from({ length: rows }).map((_, row) => <div className="admin-skeleton__row" key={row}>{Array.from({ length: columns }).map((__, column) => <i key={column} />)}</div>)}</div>;
}

export function AdminDataList<T>({ rows, primary, secondary, meta, empty }: { rows: T[]; primary: (row: T) => ReactNode; secondary?: (row: T) => ReactNode; meta?: (row: T) => ReactNode; empty?: ReactNode }) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing here yet" description="Records will appear when this area has data." />}</>;
  return <div className="admin-data-list" role="list">{rows.map((row, index) => <article key={index} role="listitem"><div><strong>{primary(row)}</strong>{secondary && <span>{secondary(row)}</span>}</div>{meta && <aside>{meta(row)}</aside>}</article>)}</div>;
}

/** A compact, semantic mobile-first record surface for dense admin collections. */
export function ResponsiveDataList<T>({ rows, primary, fields, actions, empty }: {
  rows: T[];
  primary: (row: T) => ReactNode;
  fields: Array<{ label: string; render: (row: T) => ReactNode }>;
  actions?: (row: T) => ReactNode;
  empty?: ReactNode;
}) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing here yet" description="Records will appear when this area has data." />}</>;
  return <div className="admin-responsive-list" role="list">{rows.map((row, index) => <article key={index} role="listitem" className="admin-responsive-list__item">
    <div className="admin-responsive-list__title"><strong>{primary(row)}</strong>{actions && <div>{actions(row)}</div>}</div>
    <dl>{fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.render(row)}</dd></div>)}</dl>
  </article>)}</div>;
}

export function AdminDrawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawerRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return <div className="admin-drawer-layer" role="presentation" onMouseDown={onClose}><aside ref={drawerRef} className="admin-drawer" role="dialog" aria-modal="true" aria-labelledby="admin-drawer-title" onMouseDown={(event) => event.stopPropagation()}><header><h2 id="admin-drawer-title">{title}</h2><button type="button" ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="x" size={18} /></button></header>{children}</aside></div>;
}