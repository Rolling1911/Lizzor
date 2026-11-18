import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { adminNavigation, adminPages, customerRoutes } from "./routes";
import { canonicalAdminPath } from "./adminRouting";
import { AdminLayout } from "../components/admin/AdminLayout";
import { StorefrontLayout } from "../components/storefront/StorefrontLayout";
import { WishlistProvider } from "../components/storefront/WishlistContext";
import { AdminPage } from "../pages/admin/AdminPage";
import { StorefrontPage } from "../pages/storefront/StorefrontPage";
import { BrandPage, BrandsDirectoryPage, CategoriesPage as StorefrontCategoriesPage, CategoryPage, CatalogPage, HomePage, ProductPage, WishlistPage } from "../pages/storefront/StorefrontCatalogPages";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import {
  AdminGuard,
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  TokenPage,
} from "../pages/auth/AuthPages";
import { AdminPageHeader, ErrorState } from "../components/admin/AdminPrimitives";
import { BrandsPage } from "../pages/admin/catalog/BrandsPage";
import { CatalogImportPage } from "../pages/admin/catalog/CatalogImportPage";
import { CategoriesPage } from "../pages/admin/catalog/CategoriesPage";
import { SupplierCategoryMappingsPage } from "../pages/admin/catalog/SupplierCategoryMappingsPage";
import { ProductEditorPage } from "../pages/admin/catalog/ProductEditorPage";
import { ProductListPage } from "../pages/admin/catalog/ProductListPage";
import { InventoryPage, MovementsPage, WarehousesPage } from "../pages/admin/operations/InventoryPages";
import { PricingPage } from "../pages/admin/operations/PricingPage";
import { FulfillmentPage, ReturnsPage, ShippingPage } from "../pages/admin/operations/FulfillmentPages";
import { OperationsPage } from "../pages/admin/operations/OperationsPage";
import { RefundsPage } from "../pages/admin/operations/RefundsPage";
import { ActivityLogsPage } from "../pages/admin/operations/ActivityLogsPage";
import { AdminOrderDetailPage, AdminOrdersPage, AdminPaymentDetailPage, AdminPaymentRecoveryPage, AdminPaymentsPage, CartPage, CheckoutPage, CustomerOrderDetailPage, GuestEmailOrderPage, GuestOrderDetailPage, ShopPage } from "../pages/commerce/CommercePages";
import { PromotionsPage } from "../pages/admin/marketing/PromotionsPage";
import { AnalyticsPage, ReportsPage } from "../pages/admin/analytics/AnalyticsPages";
import CommercialProfitSimulatorPage from "../pages/admin/analytics/CommercialProfitSimulatorPage";
import { AccountDashboardPage, AccountProfilePage, AddressesPage, CompaniesPage, CompanyDetailPage, CompanyMembersPage, InvitationAcceptPage, AdminCustomersPage, AdminAccountDetailPage, AccountOrdersPage, AccountNotificationsPage, AdminNotificationDeliveriesPage, CustomerGuard } from "../pages/account/AccountManagementPages";
import { StorefrontBannersPage } from "../pages/admin/storefront/StorefrontBannersPage";
import { StaffPage } from "../pages/admin/StaffPage";
import { RolesPage } from "../pages/admin/RolesPage";
import { SupportPage } from "../pages/admin/SupportPage";
import { ChatPage } from "../pages/admin/ChatPage";
import { CustomerSupportPage } from "../pages/storefront/CustomerSupportPage";
import { CustomerChatPage } from "../pages/storefront/CustomerChatPage";
import { ContentPage } from "../pages/storefront/ContentPage";
import { ContentPagesPage, HomepageControlPage, SettingsControlPage } from "../pages/admin/ContentControlPages";
import { LegalReadinessPage } from "../pages/admin/LegalReadinessPage";
import { LegalDocumentPage } from "../pages/storefront/LegalDocumentPage";
import { TooniesPage } from "../pages/admin/suppliers/TooniesPage";

function AnalyticsReportRoute() {
  const { report } = useParams();
  return <AnalyticsPage report={report as any} />;
}

function StorefrontApp() {
  return (
    <WishlistProvider><StorefrontLayout>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<TokenPage mode="reset" />} />
        <Route path="/verify-email" element={<TokenPage mode="verify" />} />
        <Route path="/account" element={<CustomerGuard><AccountDashboardPage /></CustomerGuard>} />
        <Route path="/account/profile" element={<CustomerGuard><AccountProfilePage /></CustomerGuard>} />
        <Route path="/account/addresses" element={<CustomerGuard><AddressesPage /></CustomerGuard>} />
        <Route path="/account/companies" element={<CustomerGuard><CompaniesPage /></CustomerGuard>} />
        <Route path="/account/companies/:id/members" element={<CustomerGuard><CompanyMembersPage /></CustomerGuard>} />
        <Route path="/account/companies/:id" element={<CustomerGuard><CompanyDetailPage /></CustomerGuard>} />
        <Route path="/account/invitations/accept" element={<InvitationAcceptPage />} />
        <Route path="/account/orders" element={<CustomerGuard><AccountOrdersPage /></CustomerGuard>} />
        <Route path="/account/orders/:id" element={<CustomerGuard><CustomerOrderDetailPage /></CustomerGuard>} />
        <Route path="/account/notifications" element={<CustomerGuard><AccountNotificationsPage /></CustomerGuard>} />
        <Route path="/support" element={<CustomerGuard><CustomerSupportPage /></CustomerGuard>} />
        <Route path="/chat" element={<CustomerChatPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/order-confirmation/:id" element={<GuestOrderDetailPage />} />
        <Route path="/guest-order/:id" element={<GuestEmailOrderPage />} />
        <Route path="/shop" element={<CatalogPage />} />
        <Route path="/search" element={<CatalogPage />} />
        <Route path="/deals" element={<CatalogPage mode="deals" />} />
        <Route path="/new-arrivals" element={<CatalogPage mode="new" />} />
        <Route path="/categories" element={<StorefrontCategoriesPage />} />
        <Route path="/categories/:slug" element={<CategoryPage />} />
        <Route path="/brands/:slug" element={<BrandPage />} />
        <Route path="/brands" element={<BrandsDirectoryPage />} />
        <Route path="/wishlist" element={<WishlistPage />} />
        <Route path="/products/:slug" element={<ProductPage />} />
        <Route path="/start-a-business" element={<RegisterPage businessDefault />} />
        {Object.entries(customerRoutes).map(([path, page]) => (
          !["/", "/account", "/start-a-business", "/cart", "/shop", "/categories", "/deals", "/new-arrivals", "/support", "/chat"].includes(path) &&
          <Route key={path} path={path} element={<StorefrontPage page={page} isHome={path === "/"} />} />
        ))}
        <Route path="/" element={<HomePage />} />
        <Route path="/pages/:slug" element={<ContentPage />} />
        <Route path="/legal" element={<LegalDocumentPage />} />
        <Route path="/privacy" element={<LegalDocumentPage />} />
        <Route path="/terms" element={<LegalDocumentPage />} />
        <Route path="/terms-of-sale" element={<LegalDocumentPage />} />
        <Route path="/business-terms" element={<LegalDocumentPage />} />
        <Route path="/shipping-delivery" element={<LegalDocumentPage />} />
        <Route path="/returns-refunds" element={<LegalDocumentPage />} />
        <Route path="/cookies" element={<LegalDocumentPage />} />
        <Route path="/company-information" element={<LegalDocumentPage />} />
        <Route path="/account-deletion" element={<LegalDocumentPage />} />
        <Route path="/withdrawal-rights" element={<LegalDocumentPage />} />
        <Route path="/returns" element={<Navigate to="/returns-refunds" replace />} />
        <Route path="/shipping" element={<Navigate to="/shipping-delivery" replace />} />
        <Route path="/consumer-rights" element={<Navigate to="/withdrawal-rights" replace />} />
        <Route path="/warranty" element={<LegalDocumentPage />} />
        <Route path="/payment-information" element={<LegalDocumentPage />} />
        <Route path="/contact" element={<LegalDocumentPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </StorefrontLayout></WishlistProvider>
  );
}

function AdminApp() {
  const { permissions } = useAuth();
  const catalogPaths = new Set(["/admin/products", "/admin/categories", "/admin/supplier-category-mappings", "/admin/brands", "/admin/inventory", "/admin/pricing", "/admin/promotions", "/admin/coupons", "/admin/orders", "/admin/payments", "/admin/payments/recovery", "/admin/fulfillment", "/admin/shipping", "/admin/returns", "/admin/refunds", "/admin/activity", "/admin/staff", "/admin/roles", "/admin/support", "/admin/chat", "/admin/analytics", "/admin/commercial-profit-simulator", "/admin/reports", "/admin/notifications", "/admin/operations", "/admin/storefront/banners"]);
  const protectedPage = (permission: string, page: React.ReactNode) => permissions.includes(permission)
    ? page
    : <div className="admin-page"><AdminPageHeader eyebrow="Access control" title="Permission required" description={`You need ${permission} to open this workspace.`} /><ErrorState title="This area is restricted" description="Ask an administrator to update your role. The server remains authoritative." /></div>;
  return (
    <AdminGuard><AdminLayout permissions={permissions}>
      <Routes>
        <Route path="/admin/products" element={protectedPage("products.view", <ProductListPage />)} />
        <Route path="/admin/products/new" element={protectedPage("products.create", <ProductEditorPage />)} />
        <Route path="/admin/products/import" element={protectedPage("products.import", <CatalogImportPage />)} />
        <Route path="/admin/products/:id" element={protectedPage("products.view", <ProductEditorPage />)} />
        <Route path="/admin/categories" element={protectedPage("categories.view", <CategoriesPage />)} />
        <Route path="/admin/supplier-category-mappings" element={protectedPage("supplier_category_mappings.view", <SupplierCategoryMappingsPage />)} />
        <Route path="/admin/brands" element={protectedPage("brands.view", <BrandsPage />)} />
        <Route path="/admin/inventory" element={protectedPage("inventory.view", <InventoryPage />)} />
        <Route path="/admin/inventory/movements" element={protectedPage("inventory.view", <MovementsPage />)} />
        <Route path="/admin/inventory/warehouses" element={protectedPage("warehouse.view", <WarehousesPage />)} />
        <Route path="/admin/pricing" element={protectedPage("pricing.view", <PricingPage />)} />
        <Route path="/admin/promotions" element={protectedPage("promotions.view", <PromotionsPage />)} />
        <Route path="/admin/coupons" element={protectedPage("promotions.view", <PromotionsPage couponsOnly />)} />
        <Route path="/admin/fulfillment" element={protectedPage("fulfillment.view", <FulfillmentPage />)} />
        <Route path="/admin/shipping" element={protectedPage("shipping.view", <ShippingPage />)} />
        <Route path="/admin/returns" element={protectedPage("returns.view", <ReturnsPage />)} />
        <Route path="/admin/orders" element={protectedPage("orders.view", <AdminOrdersPage />)} />
        <Route path="/admin/orders/:id" element={protectedPage("orders.view", <AdminOrderDetailPage />)} />
        <Route path="/admin/payments" element={protectedPage("payments.view", <AdminPaymentsPage />)} />
        <Route path="/admin/payments/recovery" element={protectedPage("payments.recovery.view", <AdminPaymentRecoveryPage />)} />
        <Route path="/admin/payments/:id" element={protectedPage("payments.view", <AdminPaymentDetailPage />)} />
        <Route path="/admin/refunds" element={protectedPage("refunds.view", <RefundsPage />)} />
        <Route path="/admin/activity" element={protectedPage("activity.view", <ActivityLogsPage />)} />
        <Route path="/admin/staff" element={protectedPage("staff.view", <StaffPage />)} />
        <Route path="/admin/roles" element={protectedPage("roles.view", <RolesPage />)} />
        <Route path="/admin/support" element={protectedPage("support.view", <SupportPage />)} />
        <Route path="/admin/chat" element={protectedPage("chat.view", <ChatPage />)} />
        <Route path="/admin/analytics" element={protectedPage("analytics.view", <AnalyticsPage />)} />
        <Route path="/admin/analytics/:report" element={protectedPage("analytics.view", <AnalyticsReportRoute />)} />
        <Route path="/admin/commercial-profit-simulator" element={protectedPage("analytics.view", <CommercialProfitSimulatorPage />)} />
        <Route path="/admin/reports" element={protectedPage("reports.view", <ReportsPage />)} />
        <Route path="/admin/reports/:report" element={protectedPage("reports.view", <AnalyticsReportRoute />)} />
        <Route path="/admin/customers/:id" element={protectedPage("customers.view", <AdminAccountDetailPage />)} />
        <Route path="/admin/companies/:id" element={protectedPage("companies.view", <AdminAccountDetailPage companies />)} />
        <Route path="/admin/customers" element={protectedPage("customers.view", <AdminCustomersPage />)} />
        <Route path="/admin/companies" element={protectedPage("companies.view", <AdminCustomersPage companies />)} />
        <Route path="/admin/notifications" element={protectedPage("notifications.view", <AdminNotificationDeliveriesPage />)} />
        <Route path="/admin/operations" element={protectedPage("operations.view", <OperationsPage />)} />
        <Route path="/admin/storefront/banners" element={protectedPage("storefront_banners.view", <StorefrontBannersPage />)} />
        <Route path="/admin/suppliers/toonies" element={protectedPage("supplier_integrations.view", <TooniesPage />)} />
        <Route path="/admin/homepage" element={protectedPage("homepage.view", <HomepageControlPage />)} />
        <Route path="/admin/content" element={protectedPage("content.view", <ContentPagesPage />)} />
        <Route path="/admin/settings" element={protectedPage("settings.view", <SettingsControlPage />)} />
        <Route path="/admin/legal" element={protectedPage("legal.view", <LegalReadinessPage />)} />
        {Object.entries(adminPages).map(([path, page]) => (
          !catalogPaths.has(path) &&
          <Route key={path} path={path} element={<AdminPage
            page={page}
            route={adminNavigation.find((item) => item.path === path)!}
            isDashboard={path === "/admin"}
            allowed={!adminNavigation.find((item) => item.path === path)?.permission || permissions.includes(adminNavigation.find((item) => item.path === path)!.permission!)}
          />} />
        ))}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </AdminLayout></AdminGuard>
  );
}

function RoutedApp() {
  const location = useLocation();
  const adminPath = canonicalAdminPath(location.pathname);
  if (adminPath && adminPath !== location.pathname) {
    return <Navigate to={`${adminPath}${location.search}${location.hash}`} replace />;
  }
  if (adminPath === "/admin/login") {
    return <LoginPage admin />;
  }
  return adminPath ? <AdminApp /> : <StorefrontApp />;
}

export default function App() {
  return <AuthProvider><RoutedApp /></AuthProvider>;
}