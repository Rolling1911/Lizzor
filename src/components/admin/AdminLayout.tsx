import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { adminNavigation } from "../../app/routes";
import { BrandMark } from "../ui/BrandMark";
import { Icon } from "../ui/Icon";
import { useAuth } from "../../auth/AuthContext";
import { SearchInput } from "./AdminPrimitives";

interface AdminLayoutProps {
  children: React.ReactNode;
  permissions: string[];
}

export function AdminLayout({ children, permissions }: AdminLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMobileOpen(false); setSearchOpen(false); setActionsOpen(false); }
    };
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".admin-header__tool")) { setSearchOpen(false); setActionsOpen(false); }
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutside);
    return () => { document.removeEventListener("keydown", closeOnEscape); document.removeEventListener("mousedown", closeOnOutside); };
  }, []);
  const currentItem = adminNavigation.find((item) => item.path === location.pathname)
    ?? [...adminNavigation].filter((item) => item.path !== "/admin").sort((a, b) => b.path.length - a.path.length).find((item) => location.pathname.startsWith(`${item.path}/`))
    ?? adminNavigation[0];
  const visibleItems = adminNavigation.filter((item) => !item.permission || permissions.includes(item.permission));
  const groups = visibleItems.reduce<Record<string, typeof visibleItems>>((result, item) => {
    const group = item.group ?? "Workspace";
    (result[group] ??= []).push(item);
    return result;
  }, {});

  return (
    <div className={`admin-shell ${collapsed ? "admin-shell--collapsed" : ""}`}>
      <aside className={`admin-sidebar ${mobileOpen ? "admin-sidebar--open" : ""}`}>
        <div className="admin-sidebar__brand">
          <BrandMark compact={collapsed} />
          <button className="icon-button admin-sidebar__collapse" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand admin navigation" : "Collapse admin navigation"} aria-expanded={!collapsed} title={collapsed ? "Expand navigation" : "Collapse navigation"}>
            <Icon name="chevron-down" size={16} className={collapsed ? "is-rotated" : ""} />
          </button>
          <button className="icon-button admin-sidebar__close" onClick={() => setMobileOpen(false)} aria-label="Close admin navigation">
            <Icon name="x" size={20} />
          </button>
        </div>
        <nav className="admin-nav" aria-label="Admin navigation">
          {Object.entries(groups).map(([group, items]) => <div className="admin-nav-group" key={group}>
            <div className="admin-sidebar__label">{group}</div>
            {items.map((item) => <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/admin"}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => isActive ? "is-active" : ""}
              aria-label={item.label}
              title={collapsed ? `${item.label}${item.permission ? ` · ${item.permission}` : ""}` : undefined}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </NavLink>)}
          </div>)}
        </nav>
        <div className="admin-sidebar__bottom">
          <div className="admin-sidebar__status">
            <span className="status-dot" />
              <span>Admin workspace</span>
          </div>
          <Link className="admin-sidebar__storefront" to="/">
            <Icon name="arrow-left" size={16} />
            View storefront
          </Link>
        </div>
      </aside>
      {mobileOpen && <button className="admin-sidebar__backdrop" onClick={() => setMobileOpen(false)} aria-label="Close admin navigation" />}

      <div className="admin-content">
        <header className="admin-header">
          <button className="icon-button admin-header__menu" onClick={() => setMobileOpen(true)} aria-label="Open admin navigation">
            <Icon name="menu" size={21} />
          </button>
          <div className="admin-header__crumbs">
            <span className="admin-header__root">Lizzor admin</span>
            <Icon name="arrow-right" size={14} />
            <span>{currentItem.label}</span>
          </div>
          <div className="admin-header__actions">
            <div className="admin-header__tool">
              <button className={`icon-button ${searchOpen ? "is-active" : ""}`} aria-label="Open global admin search" aria-expanded={searchOpen} onClick={() => { setSearchOpen((value) => !value); setActionsOpen(false); }}><Icon name="search" size={18} /></button>
              {searchOpen && <div className="admin-header__popover admin-search-popover"><SearchInput value={search} onChange={setSearch} placeholder="Search orders, customers, products…" /><p>{search ? "Search results depend on the connected data source." : "Search scope includes orders, customers, companies, products, SKUs, and barcodes."}</p></div>}
            </div>
            <div className="admin-header__tool">
              <button className={`admin-quick-actions ${actionsOpen ? "is-active" : ""}`} aria-label="Open quick actions" aria-expanded={actionsOpen} onClick={() => { setActionsOpen((value) => !value); setSearchOpen(false); }}><Icon name="plus" size={16} /> <span>Quick actions</span></button>
              {actionsOpen && <div className="admin-header__popover admin-actions-popover"><strong>Quick actions</strong>
                <button disabled={!permissions.includes("products.create")} onClick={() => { navigate("/admin/products/new"); setActionsOpen(false); }}><span>Add product</span><small>{permissions.includes("products.create") ? "Open editor" : "Permission required"}</small></button>
                <button disabled={!permissions.includes("promotions.create")} onClick={() => { navigate("/admin/promotions"); setActionsOpen(false); }}><span>Create promotion</span><small>{permissions.includes("promotions.create") ? "Open promotions" : "Permission required"}</small></button>
                {["Create order", "Add customer", "Send notification"].map((action) => <button key={action} disabled title="Not available in this workspace"><span>{action}</span><small>Not available</small></button>)}
              </div>}
            </div>
            <button className="icon-button admin-header__help" aria-label="Help"><Icon name="circle-help" size={19} /></button>
            <button className="icon-button" aria-label="Notifications"><Icon name="bell" size={19} /><span className="notification-dot" /></button>
            <button className="admin-avatar" aria-label="Sign out" title="Sign out" onClick={async () => {
              await logout();
              navigate("/admin/login");
            }}>L</button>
          </div>
        </header>
        <main className="admin-main" key={location.pathname}>{children}</main>
      </div>
    </div>
  );
}