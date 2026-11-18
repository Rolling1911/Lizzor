import type { NavigationItem, PlaceholderPage } from "../../shared/types";
import type { IconName } from "../components/ui/Icon";

export const customerRoutes: Record<string, PlaceholderPage> = {
  "/": {
    eyebrow: "Customer storefront",
    title: "Your wholesale workspace starts here.",
    description: "A calm, focused storefront shell ready for the Lizzor catalog.",
  },
  "/shop": {
    eyebrow: "Catalog",
    title: "Shop",
    description: "The catalog experience will appear here when the product system is connected.",
  },
  "/categories": {
    eyebrow: "Browse",
    title: "Categories",
    description: "Category browsing is ready for the database-backed catalog.",
  },
  "/deals": {
    eyebrow: "Offers",
    title: "Deals",
    description: "Promotions and wholesale offers will be managed through the admin system.",
  },
  "/new-arrivals": {
    eyebrow: "Catalog",
    title: "New arrivals",
    description: "New product collections will appear here as the catalog grows.",
  },
  "/start-a-business": {
    eyebrow: "For businesses",
    title: "Start a business",
    description: "Business account onboarding will be introduced in a later phase.",
  },
  "/cart": {
    eyebrow: "Purchase",
    title: "Your cart",
    description: "Cart and checkout flows are reserved for the commerce phase.",
  },
  "/account": {
    eyebrow: "Customer area",
    title: "Account",
    description: "Sign-in and account tools will be connected after authentication is introduced.",
  },
  "/wishlist": {
    eyebrow: "Customer area",
    title: "Wishlist",
    description: "Save-for-later functionality will be added with customer accounts.",
  },
  "/support": {
    eyebrow: "Help",
    title: "Support",
    description: "Support resources and contact channels will be connected in a later phase.",
  },
};

export const customerNavigation: NavigationItem[] = [
  { label: "Shop", path: "/shop", icon: "shopping-bag" },
  { label: "Categories", path: "/categories", icon: "layers-3" },
  { label: "Deals", path: "/deals", icon: "sparkles" },
  { label: "New arrivals", path: "/new-arrivals", icon: "arrow-up-right" },
  { label: "Brands", path: "/brands", icon: "badge" },
];

export const adminNavigation = [
  { label: "Dashboard", path: "/admin", icon: "layout-dashboard", group: "Overview", permission: "dashboard.view" },
  { label: "Operations", path: "/admin/operations", icon: "list-checks", group: "Overview", permission: "operations.view" },
  { label: "Orders", path: "/admin/orders", icon: "package", group: "Commerce", permission: "orders.view" },
  { label: "Customers", path: "/admin/customers", icon: "users", group: "Commerce", permission: "customers.view" },
  { label: "Companies", path: "/admin/companies", icon: "building-2", group: "Commerce", permission: "companies.view" },
  { label: "Products", path: "/admin/products", icon: "boxes", group: "Catalog", permission: "products.view" },
  { label: "Categories", path: "/admin/categories", icon: "layers-3", group: "Catalog", permission: "categories.view" },
  { label: "Supplier mappings", path: "/admin/supplier-category-mappings", icon: "link-2", group: "Catalog", permission: "supplier_category_mappings.view" },
  { label: "Brands", path: "/admin/brands", icon: "badge", group: "Catalog", permission: "brands.view" },
  { label: "Toonies supplier", path: "/admin/suppliers/toonies", icon: "truck", group: "Catalog", permission: "supplier_integrations.view" },
  { label: "Inventory", path: "/admin/inventory", icon: "warehouse", group: "Catalog", permission: "inventory.view" },
  { label: "Fulfillment", path: "/admin/fulfillment", icon: "package", group: "Operations", permission: "fulfillment.view" },
  { label: "Pricing", path: "/admin/pricing", icon: "badge-percent", group: "Catalog", permission: "pricing.view" },
  { label: "Promotions", path: "/admin/promotions", icon: "megaphone", group: "Marketing", permission: "promotions.view" },
  { label: "Coupons", path: "/admin/coupons", icon: "ticket", group: "Marketing", permission: "coupons.view" },
  { label: "Notifications", path: "/admin/notifications", icon: "bell", group: "Marketing", permission: "notifications.view" },
  { label: "Shipping", path: "/admin/shipping", icon: "truck", group: "Operations", permission: "shipping.view" },
  { label: "Returns", path: "/admin/returns", icon: "undo-2", group: "Operations", permission: "returns.view" },
  { label: "Refunds", path: "/admin/refunds", icon: "receipt-text", group: "Operations", permission: "refunds.view" },
  { label: "Payments", path: "/admin/payments", icon: "credit-card", group: "Operations", permission: "payments.view" },
  { label: "Support", path: "/admin/support", icon: "life-buoy", group: "Customer care", permission: "support.view" },
  { label: "Live chat", path: "/admin/chat", icon: "messages-square", group: "Customer care", permission: "chat.view" },
  { label: "Analytics", path: "/admin/analytics", icon: "chart-no-axes-combined", group: "Insights", permission: "analytics.view" },
  { label: "Profit simulator", path: "/admin/commercial-profit-simulator", icon: "badge-percent", group: "Insights", permission: "analytics.view" },
  { label: "Reports", path: "/admin/reports", icon: "file-chart-column", group: "Insights", permission: "reports.view" },
  { label: "Homepage", path: "/admin/homepage", icon: "house", group: "Content", permission: "homepage.view" },
  { label: "Banners", path: "/admin/storefront/banners", icon: "panel-top", group: "Content", permission: "storefront_banners.view" },
  { label: "Content", path: "/admin/content", icon: "panel-top", group: "Content", permission: "content.view" },
  { label: "Staff", path: "/admin/staff", icon: "users-round", group: "Administration", permission: "staff.view" },
  { label: "Roles & permissions", path: "/admin/roles", icon: "shield-check", group: "Administration", permission: "roles.view" },
  { label: "Activity logs", path: "/admin/activity", icon: "list-checks", group: "Administration", permission: "activity.view" },
  { label: "Settings", path: "/admin/settings", icon: "settings-2", group: "Administration", permission: "settings.view" },
  { label: "Legal & Compliance", path: "/admin/legal", icon: "scale", group: "Administration", permission: "legal.view" },
] satisfies Array<Omit<NavigationItem, "icon"> & { icon: IconName }>;

export const adminPages: Record<string, PlaceholderPage> = Object.fromEntries(
  adminNavigation.map((item) => [
    item.path,
    item.path === "/admin"
      ? {
          eyebrow: "Lizzor administration",
          title: "Dashboard",
          description: "The operational home for your wholesale platform.",
        }
      : {
          eyebrow: ["Products", "Categories", "Brands"].includes(item.label) ? "Catalog management" : "Administration",
          title: item.label,
           description: item.label === "Products"
            ? "Manage parent products, variants, media, imports, and publishing."
            : item.label === "Categories"
              ? "Organize products in a nested, ordered hierarchy."
               : item.label === "Supplier mappings"
                 ? "Review supplier category paths and map them into the Lizzor hierarchy."
              : item.label === "Brands"
                ? "Maintain the catalog brand directory."
                : item.label === "Inventory"
                  ? "Control stock, warehouses, thresholds, movements, and transfers."
                  : item.label === "Pricing"
                    ? "Configure product and variant wholesale quantity tiers."
                   : item.label === "Banners"
                     ? "Manage the responsive artwork and launch state used by the Lizzor homepage."
                     : "This foundation route is ready for the next Lizzor development phase.",
        },
  ]),
);