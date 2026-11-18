import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, FormSection, LoadingState, StatusBadge } from "../../components/admin/AdminPrimitives";

type Role = { id: string; name: string; description: string | null; active: boolean; systemKey: string | null; staffAssignable: boolean; staffCount: number; permissionCount: number; createdAt: string; updatedAt: string };
type Permission = { id: string; permissionKey: string; description: string | null };
type RoleDetail = { role: Role; permissions: Permission[] };
type RoleFilter = "all" | "active" | "inactive" | "assignable" | "not-assignable" | "staff" | "no-staff";

const highRiskPermissionKeys = new Set([
  "products.delete",
  "inventory.delete",
  "refunds.view",
  "refunds.manage",
  "payments.recovery.view",
  "payments.recovery.manage",
  "payments.reconcile",
  "roles.manage",
  "staff.manage",
  "legal.manage",
  "product_cost.view",
  "analytics.margin",
]);

const resourceLabels: Record<string, string> = {
  dashboard: "administration dashboard",
  products: "products",
  categories: "categories",
  brands: "brands",
  product_cost: "product costs",
  inventory: "inventory records",
  warehouse: "warehouse configuration",
  orders: "orders",
  customers: "customer accounts",
  companies: "company accounts",
  pricing: "pricing",
  promotions: "promotions",
  coupons: "coupons",
  shipping: "shipping configuration",
  fulfillment: "fulfillment operations",
  payments: "payments",
  "payments.recovery": "payment recovery",
  returns: "returns",
  refunds: "refunds",
  activity: "audit activity",
  notifications: "notifications",
  support: "support cases",
  chat: "customer chat",
  analytics: "analytics",
  reports: "reports",
  homepage: "homepage content",
  storefront_banners: "storefront banners",
  content: "managed content",
  staff: "administrator staff",
  roles: "roles and permissions",
  settings: "administration settings",
  operations: "operational controls",
  legal: "legal documents and publication",
};

function permissionDescription(permission: Permission) {
  const stored = permission.description?.trim();
  if (stored && stored.toLowerCase() !== "system permission") return stored;
  const segments = permission.permissionKey.split(".");
  const action = segments.pop() ?? "";
  const resource = resourceLabels[segments.join(".")] ?? segments.join(" ").replaceAll("_", " ");
  const descriptions: Record<string, string> = {
    view: `View ${resource}.`,
    create: `Create new ${resource}.`,
    edit: `Edit existing ${resource}.`,
    archive: `Archive and restore eligible ${resource}.`,
    import: `Import ${resource} from supported files.`,
    export: `Export ${resource} data.`,
    delete: `Permanently delete eligible ${resource}.`,
    manage: `Manage ${resource} and perform operational changes.`,
    adjust: `Record stock adjustments for ${resource}.`,
    transfer: `Transfer stock between inventory locations.`,
    bulk: `Apply approved bulk changes to ${resource}.`,
    reconcile: `Reconcile provider payment records with internal orders.`,
    sales: `View sales analytics and performance.`,
    customers: `View customer analytics and trends.`,
    inventory: `View inventory analytics and stock trends.`,
    margin: `View cost, margin, and profitability analytics.`,
    promotions: `View promotion analytics and performance.`,
  };
  return descriptions[action] ?? `Use the ${permission.permissionKey} administration capability.`;
}

function groupLabel(group: string) {
  return group.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function RolesPage() {
  const { permissions: currentPermissions, isSuperAdmin } = useAuth();
  const canManage = currentPermissions.includes("roles.manage") && isSuperAdmin;
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissionGroups, setPermissionGroups] = useState<Record<string, Permission[]>>({});
  const [detail, setDetail] = useState<RoleDetail | null>(null);
  const [selectedPermissionIds, setSelectedPermissionIds] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "" });
  const [editForm, setEditForm] = useState({ name: "", description: "", active: true, staffAssignable: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const createTrigger = useRef<HTMLButtonElement>(null);
  const createDialog = useRef<HTMLFormElement>(null);
  const createNameInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [roleResult, permissionResult] = await Promise.all([
        apiRequest<{ data: { items: Role[] } }>("/admin/roles"),
        apiRequest<{ data: { groups: Record<string, Permission[]> } }>("/admin/permissions"),
      ]);
      setRoles(roleResult.data.items);
      setPermissionGroups(permissionResult.data.groups);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Roles could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  const inspect = useCallback(async (roleId: string) => {
    setError("");
    setNotice("");
    try {
      const result = (await apiRequest<{ data: RoleDetail }>(`/admin/roles/${roleId}`)).data;
      setDetail(result);
      setSelectedPermissionIds(result.permissions.map((permission) => permission.id));
      setEditForm({ name: result.role.name, description: result.role.description ?? "", active: result.role.active, staffAssignable: result.role.staffAssignable });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Role detail could not be loaded.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!showCreate) return;
    createNameInput.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCreate();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showCreate]);

  const roleCounts = useMemo(() => ({
    total: roles.length,
    active: roles.filter((role) => role.active).length,
    inactive: roles.filter((role) => !role.active).length,
    assignable: roles.filter((role) => role.staffAssignable && role.systemKey !== "super_admin").length,
    withStaff: roles.filter((role) => role.staffCount > 0).length,
    withoutStaff: roles.filter((role) => role.staffCount === 0).length,
  }), [roles]);

  const visibleRoles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return roles.filter((role) => {
      const matchesSearch = !query || role.name.toLowerCase().includes(query) || role.description?.toLowerCase().includes(query) || role.systemKey?.toLowerCase().includes(query);
      const matchesFilter = filter === "all"
        || (filter === "active" && role.active)
        || (filter === "inactive" && !role.active)
        || (filter === "assignable" && role.staffAssignable && role.systemKey !== "super_admin")
        || (filter === "not-assignable" && !role.staffAssignable)
        || (filter === "staff" && role.staffCount > 0)
        || (filter === "no-staff" && role.staffCount === 0);
      return matchesSearch && matchesFilter;
    });
  }, [filter, roles, search]);

  async function createRole(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = (await apiRequest<{ data: RoleDetail }>("/admin/roles", { method: "POST", body: JSON.stringify({ ...createForm, description: createForm.description || null }) })).data;
      closeCreate();
      setCreateForm({ name: "", description: "" });
      setNotice("Role created. Assign permissions before using it for staff access.");
      await load();
      await inspect(result.role.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Role could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRole(event: React.FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/admin/roles/${detail.role.id}`, { method: "PATCH", body: JSON.stringify({ ...editForm, description: editForm.description || null }) });
      setNotice("Role details updated.");
      await load();
      await inspect(detail.role.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Role could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function savePermissions() {
    if (!detail) return;
    const existingIds = new Set(detail.permissions.map((permission) => permission.id));
    const permissionsById = new Map(Object.values(permissionGroups).flat().map((permission) => [permission.id, permission]));
    const newlyGrantedHighRisk = selectedPermissionIds
      .filter((permissionId) => !existingIds.has(permissionId))
      .map((permissionId) => permissionsById.get(permissionId))
      .filter((permission): permission is Permission => Boolean(permission && highRiskPermissionKeys.has(permission.permissionKey)));
    if (newlyGrantedHighRisk.length && !window.confirm(`Grant ${newlyGrantedHighRisk.length} high-risk permission${newlyGrantedHighRisk.length === 1 ? "" : "s"} to ${detail.role.name}?\n\n${newlyGrantedHighRisk.map((permission) => `• ${permission.permissionKey}`).join("\n")}\n\nThese permissions can expose sensitive data or authorize consequential administration actions.`)) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/admin/roles/${detail.role.id}/permissions`, { method: "PUT", body: JSON.stringify({ permissionIds: selectedPermissionIds }) });
      setNotice("Role permissions updated. Permission checks take effect immediately.");
      await load();
      await inspect(detail.role.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Permissions could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  function togglePermission(permissionId: string) {
    setSelectedPermissionIds((current) => current.includes(permissionId) ? current.filter((id) => id !== permissionId) : [...current, permissionId]);
  }

  function setGroupPermissions(groupPermissions: Permission[], selected: boolean) {
    const groupIds = new Set(groupPermissions.map((permission) => permission.id));
    setSelectedPermissionIds((current) => selected
      ? [...new Set([...current, ...groupIds])]
      : current.filter((permissionId) => !groupIds.has(permissionId)));
  }

  function toggleGroup(group: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }

  function closeCreate() {
    setShowCreate(false);
    requestAnimationFrame(() => createTrigger.current?.focus());
  }

  function containModalFocus(event: React.KeyboardEvent) {
    if (event.key !== "Tab" || !createDialog.current) return;
    const focusable = [...createDialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="admin-page roles-page">
    <AdminPageHeader eyebrow="Administration" title="Roles & permissions" description="Define administrator responsibilities with active roles and server-enforced permissions." actions={canManage && <button ref={createTrigger} className="button button--dark button--small" onClick={() => setShowCreate(true)}>Create role</button>} />
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    {error && <ErrorState title="Role action failed" description={error} onRetry={() => void load()} />}
    <section className="admin-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Access roles</span><h2>{roleCounts.total} roles</h2></div><span className="section-note">Inactive roles grant no access</span></div>
      <div className="role-counts" aria-label="Role counts">
        <span><strong>{roleCounts.total}</strong>Total</span>
        <span><strong>{roleCounts.active}</strong>Active</span>
        <span><strong>{roleCounts.inactive}</strong>Inactive</span>
        <span><strong>{roleCounts.assignable}</strong>Assignable</span>
        <span><strong>{roleCounts.withStaff}</strong>Has staff</span>
        <span><strong>{roleCounts.withoutStaff}</strong>No staff</span>
      </div>
      <div className="role-toolbar">
        <label className="role-search"><span>Search roles</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or description" /></label>
        <div className="role-filters" role="group" aria-label="Filter roles">
          {([
            ["all", "All"],
            ["active", "Active"],
            ["inactive", "Inactive"],
            ["assignable", "Assignable"],
            ["not-assignable", "Not assignable"],
            ["staff", "Has staff"],
            ["no-staff", "No staff"],
          ] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
      </div>
      {!loading && <p className="role-results-count" aria-live="polite">{visibleRoles.length} of {roles.length} roles shown</p>}
      {loading ? <LoadingState label="Loading roles and permissions…" /> : visibleRoles.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Role</th><th>Status</th><th>Staff assignment</th><th>Staff</th><th>Permissions</th><th /></tr></thead><tbody>{visibleRoles.map((role) => <tr key={role.id} className={detail?.role.id === role.id ? "is-selected" : undefined}><td><strong>{role.name}</strong>{role.systemKey === "super_admin" && <span className="role-protected-badge">Protected</span>}<small className="table-subline">{role.description || "No description provided"}</small></td><td><StatusBadge status={role.active ? "Active" : "Inactive"} tone={role.active ? "positive" : "neutral"} /></td><td><StatusBadge status={role.systemKey === "super_admin" ? "Protected system role" : role.staffAssignable ? "Assignable" : "Not assignable"} tone={role.staffAssignable ? "positive" : "neutral"} /></td><td>{role.staffCount}</td><td>{role.permissionCount}</td><td><button className="button button--quiet button--small" onClick={() => void inspect(role.id)}>Inspect</button></td></tr>)}</tbody></table></div> : <EmptyState title="No matching roles" description="Try a different search or role filter." icon="users" />}
    </section>
    <section className="admin-panel">
      {detail ? <>
        <div className="admin-panel__heading"><div><span className="eyebrow">Role detail</span><h2>{detail.role.name}</h2></div><div className="role-detail-status">{detail.role.systemKey === "super_admin" && <span className="role-protected-badge">Protected system role</span>}<StatusBadge status={detail.role.active ? "Active" : "Inactive"} tone={detail.role.active ? "positive" : "neutral"} /></div></div>
        <form onSubmit={saveRole}><FormSection title="Role settings" description="Deactivating a role immediately stops it granting permissions. The final valid administrator and Super Admin are protected by the server."><div className="catalog-grid catalog-grid--two"><label className="catalog-field">Role name<input disabled={!canManage || Boolean(detail.role.systemKey)} required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></label><label className="catalog-field">Status<select disabled={!canManage || Boolean(detail.role.systemKey)} value={editForm.active ? "active" : "inactive"} onChange={(event) => setEditForm({ ...editForm, active: event.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div><label className="catalog-field">Description<textarea disabled={!canManage} rows={3} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></label><label className="catalog-field">Staff assignment<select disabled={!canManage || Boolean(detail.role.systemKey) || !editForm.active} value={detail.role.systemKey === "super_admin" ? "protected" : editForm.staffAssignable ? "assignable" : "not-assignable"} onChange={(event) => setEditForm({ ...editForm, staffAssignable: event.target.value === "assignable" })}><option value="not-assignable">Not assignable</option><option value="assignable">Assignable</option>{detail.role.systemKey === "super_admin" && <option value="protected">Protected system role</option>}</select><span>{detail.role.systemKey === "super_admin" ? "The canonical Super Admin cannot be assigned through Staff administration." : "Disabling future assignment does not remove this role from existing staff."}</span></label>{canManage && <button className="button button--quiet button--small" disabled={busy}>Save role settings</button>}</FormSection></form>
        <FormSection title="Permissions" description={detail.role.systemKey === "super_admin" ? "The protected Super Admin retains every registered permission. Permission changes are not available for this role." : "Permissions are grouped by workspace. Changes are enforced by the server on the next request."}>
          <div className="permission-groups">{Object.entries(permissionGroups).map(([group, permissions]) => {
            const expanded = expandedGroups.has(group);
            const selectedCount = permissions.filter((permission) => selectedPermissionIds.includes(permission.id)).length;
            return <section key={group} className="permission-group">
              <button type="button" className="permission-group__toggle" aria-expanded={expanded} aria-controls={`permission-group-${group}`} onClick={() => toggleGroup(group)}>
                <span><strong>{groupLabel(group)}</strong><small>{selectedCount} / {permissions.length} selected</small></span>
                <span aria-hidden="true">{expanded ? "−" : "+"}</span>
              </button>
              {expanded && <div id={`permission-group-${group}`} className="permission-group__body">
                {canManage && !detail.role.systemKey && <div className="permission-group__controls"><button type="button" disabled={selectedCount === permissions.length} onClick={() => setGroupPermissions(permissions, true)}>Select all</button><button type="button" disabled={selectedCount === 0} onClick={() => setGroupPermissions(permissions, false)}>Clear all</button></div>}
                <div className="permission-group__options">{permissions.map((permission) => {
                  const highRisk = highRiskPermissionKeys.has(permission.permissionKey);
                  return <label key={permission.id} className={`permission-option ${highRisk ? "is-high-risk" : ""}`}><input type="checkbox" disabled={!canManage || Boolean(detail.role.systemKey)} checked={selectedPermissionIds.includes(permission.id)} onChange={() => togglePermission(permission.id)} /><span><strong>{permission.permissionKey}{highRisk && <em>High risk</em>}</strong><small>{permissionDescription(permission)}</small></span></label>;
                })}</div>
              </div>}
            </section>;
          })}</div>
          {canManage && !detail.role.systemKey && <button className="button button--dark button--small" disabled={busy} onClick={() => void savePermissions()}>Save permissions</button>}
        </FormSection>
      </> : <EmptyState title="Inspect a role" description="Choose a role to review its status, staff usage, and logically grouped permissions." icon="users" />}
    </section>
    {showCreate && <div className="admin-modal-backdrop" role="presentation" onClick={closeCreate}><form ref={createDialog} className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="create-role-title" onSubmit={createRole} onKeyDown={containModalFocus} onClick={(event) => event.stopPropagation()}><div className="admin-panel__heading"><div><span className="eyebrow">Access model</span><h2 id="create-role-title">Create role</h2></div><button type="button" className="button button--quiet button--small" onClick={closeCreate}>Close</button></div><div className="catalog-stack"><label className="catalog-field">Name<input ref={createNameInput} required value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} /></label><label className="catalog-field">Description<textarea rows={3} value={createForm.description} onChange={(event) => setCreateForm({ ...createForm, description: event.target.value })} /></label><button className="button button--dark" disabled={busy}>{busy ? "Creating…" : "Create role"}</button></div></form></div>}
  </div>;
}