import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, FilterBar, FormSection, LoadingState, Pagination, SearchInput, StatusBadge } from "../../components/admin/AdminPrimitives";

type Role = { id: string; name: string; active: boolean; systemKey: string | null; staffAssignable: boolean };
type Staff = { id: string; email: string; firstName: string; lastName: string; phone: string | null; status: string; emailVerifiedAt: string | null; createdAt: string; updatedAt: string; roles: Role[] };
type StaffList = { items: Staff[]; meta: { page: number; pageSize: number; total: number; hasNext: boolean } };
type StaffDetail = { staff: Staff; activeAdminSessions: number; pendingInvitations: number; invitation?: { status: string; providerConfigured: boolean; message: string } };
const tone = (status: string): "neutral" | "positive" | "warning" | "negative" => status === "active" ? "positive" : status === "pending" ? "warning" : "negative";

export function StaffPage() {
  const { permissions, isSuperAdmin } = useAuth();
  const canManage = permissions.includes("staff.manage") && isSuperAdmin;
  const canGrantAccess = canManage;
  const canViewRoles = permissions.includes("roles.view");
  const [data, setData] = useState<StaffList | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "", phone: "", roleIds: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      const requests: [Promise<{ data: StaffList }>, Promise<{ data: { items: Role[] } }> | null] = [
        apiRequest<{ data: StaffList }>(`/admin/staff?${params}`),
        canGrantAccess ? apiRequest<{ data: { items: Role[] } }>("/admin/staff-role-options") : null,
      ];
      const [staffResult, rolesResult] = await Promise.all(requests);
      setData(staffResult.data);
      if (rolesResult) setRoles(rolesResult.data.items);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Staff could not be loaded."); }
    finally { setLoading(false); }
  }, [canGrantAccess, page, search, status]);

  const inspect = useCallback(async (id: string) => {
    setSelectedId(id); setNotice(""); setError("");
    try { setDetail((await apiRequest<{ data: StaffDetail }>(`/admin/staff/${id}`)).data); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Staff detail could not be loaded."); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createStaff(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await apiRequest<{ data: StaffDetail }>("/admin/staff", { method: "POST", body: JSON.stringify({ ...form, phone: form.phone || null }) });
      setNotice(result.data.invitation?.message ?? "Staff account created.");
      setShowCreate(false); setForm({ email: "", firstName: "", lastName: "", phone: "", roleIds: [] });
      await load(); await inspect(result.data.staff.id);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Staff account could not be created."); }
    finally { setBusy(false); }
  }

  async function changeStatus(nextStatus: "active" | "suspended" | "deactivated") {
    if (!detail || !canManage) return;
    setBusy(true); setError("");
    try { await apiRequest(`/admin/staff/${detail.staff.id}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) }); setNotice(`Staff status changed to ${nextStatus}.`); await Promise.all([load(), inspect(detail.staff.id)]); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Staff status could not be changed."); }
    finally { setBusy(false); }
  }

  async function saveRoles() {
    if (!detail || !canGrantAccess) return;
    setBusy(true); setError("");
    try {
      const roleIds = detail.staff.roles.map((role) => role.id);
      await apiRequest(`/admin/staff/${detail.staff.id}/roles`, { method: "PUT", body: JSON.stringify({ roleIds }) });
      setNotice("Staff roles updated and existing admin sessions were revoked.");
      if (roleIds.length) await Promise.all([load(), inspect(detail.staff.id)]);
      else { setSelectedId(null); setDetail(null); await load(); }
    }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Staff roles could not be updated."); }
    finally { setBusy(false); }
  }

  function toggleRole(roleId: string) {
    if (!detail) return;
    const selected = detail.staff.roles;
    if (selected.some((role) => role.id === roleId)) {
      setDetail({ ...detail, staff: { ...detail.staff, roles: selected.filter((role) => role.id !== roleId) } });
      return;
    }
    const approved = roles.find((role) => role.id === roleId);
    if (approved) setDetail({ ...detail, staff: { ...detail.staff, roles: [...selected, approved] } });
  }

  return <div className="admin-page">
    <AdminPageHeader eyebrow="Administration" title="Staff" description="Manage administrator identity, account status, role access, and invitation readiness." actions={canManage && <button className="button button--dark button--small" onClick={() => setShowCreate(true)}>Invite staff</button>} />
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    {error && <ErrorState title="Staff action failed" description={error} onRetry={() => void load()} />}
    <section className="admin-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Administrator accounts</span><h2>{data?.meta.total.toLocaleString() ?? "—"} staff accounts</h2></div><span className="section-note">Server-authorized</span></div>
      <FilterBar><SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search name, email, or ID…" /><label className="admin-filter">Status<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="pending">Pending invite</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="deactivated">Deactivated</option></select></label></FilterBar>
      {loading ? <LoadingState label="Loading staff accounts…" /> : data?.items.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Staff</th><th>Status</th><th>Roles</th><th>Sessions</th><th>Created</th><th /></tr></thead><tbody>{data.items.map((staff) => <tr key={staff.id} className={selectedId === staff.id ? "is-selected" : undefined}><td><strong>{staff.firstName} {staff.lastName}</strong><small className="table-subline">{staff.email}</small></td><td><StatusBadge status={staff.status} tone={tone(staff.status)} /></td><td>{staff.roles.length ? staff.roles.map((role) => role.name).join(", ") : "No active roles"}</td><td>—</td><td>{new Date(staff.createdAt).toLocaleDateString()}</td><td><button className="button button--quiet button--small" onClick={() => void inspect(staff.id)}>Inspect</button></td></tr>)}</tbody></table></div> : <EmptyState title="No staff accounts" description="Invite an administrator when your team is ready. No sample staff records have been added." icon="users" />}
      {data?.items.length ? <Pagination page={data.meta.page} hasNext={data.meta.hasNext} onChange={setPage} /> : null}
    </section>
    <section className="admin-panel">
      {detail ? <><div className="admin-panel__heading"><div><span className="eyebrow">Staff detail</span><h2>{detail.staff.firstName} {detail.staff.lastName}</h2></div><button className="button button--quiet button--small" onClick={() => { setSelectedId(null); setDetail(null); }}>Close</button></div><dl className="admin-detail-list"><div><dt>Email</dt><dd>{detail.staff.email}</dd></div><div><dt>Phone</dt><dd>{detail.staff.phone ?? "—"}</dd></div><div><dt>Status</dt><dd><StatusBadge status={detail.staff.status} tone={tone(detail.staff.status)} /></dd></div><div><dt>Email verification</dt><dd>{detail.staff.emailVerifiedAt ? "Verified" : "Pending"}</dd></div><div><dt>Active admin sessions</dt><dd>{detail.activeAdminSessions}</dd></div><div><dt>Pending invitations</dt><dd>{detail.pendingInvitations}</dd></div></dl>{canManage && <div className="admin-form-actions">{detail.staff.status === "active" ? <><button className="button button--quiet button--small" disabled={busy} onClick={() => void changeStatus("suspended")}>Suspend account</button><button className="button button--quiet button--small" disabled={busy} onClick={() => void changeStatus("deactivated")}>Deactivate account</button></> : <button className="button button--dark button--small" disabled={busy} onClick={() => void changeStatus("active")}>Activate account</button>}</div>}{canManage && <FormSection title="Assigned roles" description="Only approved roles can be newly assigned. Legacy roles may remain or be removed. Saving revokes existing admin sessions."><div className="role-checkboxes">{[...detail.staff.roles.filter((assigned) => !roles.some((role) => role.id === assigned.id)), ...roles].map((role) => { const legacy = !roles.some((approved) => approved.id === role.id); return <label key={role.id}><input type="checkbox" checked={detail.staff.roles.some((assigned) => assigned.id === role.id)} onChange={() => toggleRole(role.id)} />{role.name}{legacy && <small>Legacy / non-assignable</small>}</label>; })}</div><button className="button button--quiet button--small" disabled={busy} onClick={() => void saveRoles()}>Save roles</button></FormSection>}{!canManage && <p className="section-note">Role assignment is restricted to administrators with staff management access.</p>}{canViewRoles && <Link className="text-link" to="/admin/roles">Review roles and permissions</Link>}</> : <EmptyState title="Inspect a staff account" description="Choose an administrator to review identity, status, sessions, and assigned roles." icon="users" />}
    </section>
    {showCreate && <div className="admin-modal-backdrop" role="presentation" onClick={() => setShowCreate(false)}><form className="admin-modal" onSubmit={createStaff} onClick={(event) => event.stopPropagation()}><div className="admin-panel__heading"><div><span className="eyebrow">New administrator</span><h2>Invite staff</h2></div><button type="button" className="button button--quiet button--small" onClick={() => setShowCreate(false)}>Close</button></div><p className="section-note">The account starts pending. A secure password setup email is queued; no password or token is shown here.</p><div className="catalog-stack"><label className="catalog-field">First name<input required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} /></label><label className="catalog-field">Last name<input required value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} /></label><label className="catalog-field">Email<input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label><label className="catalog-field">Phone <span>Optional</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>{roles.length ? <label className="catalog-field">Initial roles<select multiple required value={form.roleIds} onChange={(event) => setForm({ ...form, roleIds: [...event.target.selectedOptions].map((option) => option.value) })}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label> : <div className="admin-empty-inline" role="status"><strong>No staff roles are currently approved for assignment.</strong><span>Enable staff assignment for a role in Roles &amp; permissions.</span></div>}<button className="button button--dark" disabled={busy || !form.roleIds.length || !roles.length}>{busy ? "Creating…" : "Create and invite"}</button></div></form></div>}
  </div>;
}