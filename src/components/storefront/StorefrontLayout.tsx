import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { customerNavigation } from "../../app/routes";
import { BrandMark } from "../ui/BrandMark";
import { Icon } from "../ui/Icon";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { publicCategories, publicCategoryChildren } from "./publicDisplay";
import { LegalNavigation } from "../legal/LegalNavigation";
import { CookieConsent } from "../legal/CookieConsent";
import { EUROPEAN_COUNTRIES, EUROPEAN_COUNTRY_NAMES } from "../../../shared/europeanCountries";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "../../lib/browserStorage";

interface StorefrontLayoutProps {
  children: React.ReactNode;
}

interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
  imageUrl?: string | null;
  description?: string | null;
}

const LANGUAGES = [{ code: "EN", label: "English" }] as const;

export function StorefrontLayout({ children }: StorefrontLayoutProps) {
  const { sessionType, user, loading: authLoading, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [selectedDesktopCategoryId, setSelectedDesktopCategoryId] = useState<string | null>(null);
  const [expandedMobileCategories, setExpandedMobileCategories] = useState<string[]>([]);
  const [openFooterSection, setOpenFooterSection] = useState<"marketplace" | "account" | "support" | "contact" | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [utilityMenuOpen, setUtilityMenuOpen] = useState<"country" | "language" | null>(null);
  const [shipToCountry, setShipToCountry] = useState("Cyprus");
  const [countrySearch, setCountrySearch] = useState("");
  const [categories, setCategories] = useState<StorefrontCategory[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const categoryMenuRef = useRef<HTMLDivElement>(null);
  const categoryMenuButtonRef = useRef<HTMLButtonElement>(null);
  const categoryHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utilityMenuRef = useRef<HTMLDivElement>(null);
  const countryTriggerRef = useRef<HTMLButtonElement>(null);
  const languageTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const signedIn = sessionType === "customer" && Boolean(user);
  const customerName = user?.firstName?.trim() || "Customer";
  const signOut = async () => {
    await logout();
    setAccountMenuOpen(false);
    setMobileOpen(false);
    navigate("/");
  };
  const [cartCount, setCartCount] = useState(0);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [siteSettings, setSiteSettings] = useState({ storeName: "Lizzor", storefrontAnnouncement: "" });
  useEffect(() => {
    const savedCountry = safeLocalStorageGet("lizzor.shipToCountry");
    if (savedCountry && EUROPEAN_COUNTRY_NAMES.includes(savedCountry)) setShipToCountry(savedCountry);
    else if (savedCountry) safeLocalStorageRemove("lizzor.shipToCountry");
  }, []);
  useEffect(() => {
    safeLocalStorageSet("lizzor.shipToCountry", shipToCountry);
  }, [shipToCountry]);
  useEffect(() => {
    apiRequest<{ data: { storeName?: string; storefrontAnnouncement?: string } }>("/storefront/site-settings")
      .then((response) => setSiteSettings({ storeName: response.data.storeName || "Lizzor", storefrontAnnouncement: response.data.storefrontAnnouncement || "" }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    apiRequest<{ data: { items?: Array<{ quantity: number }> } }>("/cart")
      .then((response) => setCartCount((response.data.items ?? []).reduce((sum, item) => sum + item.quantity, 0)))
      .catch(() => setCartCount(0));
  }, [location.pathname]);
  useEffect(() => {
    if (sessionType !== "customer") {
      setUnreadNotifications(0);
      return;
    }
    apiRequest<any>("/account/notifications?limit=1")
      .then((response) => {
        const data = response?.data ?? response;
        setUnreadNotifications(data?.unreadCount ?? data?.meta?.unreadCount ?? 0);
      })
      .catch(() => setUnreadNotifications(0));
  }, [location.pathname, sessionType]);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = mobileDrawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => mobileCloseButtonRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      if (document.activeElement instanceof HTMLElement && mobileDrawerRef.current?.contains(document.activeElement)) {
        mobileMenuButtonRef.current?.focus();
      }
    };
  }, [mobileOpen]);

  useEffect(() => {
    apiRequest<{ data: StorefrontCategory[] }>("/catalog/categories")
      .then((response) => setCategories(response.data))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!categoryMenuOpen || !publicRootCategories.length) return;
    setSelectedDesktopCategoryId((current) => publicRootCategories.some((category) => category.id === current) ? current : publicRootCategories[0].id);
    return () => {
      if (categoryHoverTimerRef.current) clearTimeout(categoryHoverTimerRef.current);
    };
  }, [categoryMenuOpen, categories]);

  useEffect(() => {
    if (!categoryMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !categoryMenuRef.current?.contains(event.target) && !categoryMenuButtonRef.current?.contains(event.target)) {
        setCategoryMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCategoryMenuOpen(false);
        requestAnimationFrame(() => categoryMenuButtonRef.current?.focus());
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [categoryMenuOpen]);

  useEffect(() => {
    if (!utilityMenuOpen) return;
    const openedMenu = utilityMenuOpen;
    const focusTrigger = () => requestAnimationFrame(() => {
      (openedMenu === "country" ? countryTriggerRef.current : languageTriggerRef.current)?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !utilityMenuRef.current?.contains(event.target)) {
        setUtilityMenuOpen(null);
        focusTrigger();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setUtilityMenuOpen(null);
        focusTrigger();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [utilityMenuOpen]);

  useEffect(() => {
    const query = new URLSearchParams(location.search).get("q");
    setSearch(query ?? "");
  }, [location.search]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setCategoryMenuOpen(false);
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = search.trim();
    if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
  }

  function closeUtilityMenu() {
    const openedMenu = utilityMenuOpen;
    setUtilityMenuOpen(null);
    requestAnimationFrame(() => {
      (openedMenu === "country" ? countryTriggerRef.current : languageTriggerRef.current)?.focus();
    });
  }

  const publicRootCategories = publicCategories(categories.filter((category) => !category.parentId));
  const categoryChildren = (parentId: string) => publicCategoryChildren(categories, parentId);
  const selectedDesktopCategory = publicRootCategories.find((category) => category.id === selectedDesktopCategoryId) ?? publicRootCategories[0];
  const selectedDesktopChildren = selectedDesktopCategory ? categoryChildren(selectedDesktopCategory.id) : [];
  const otherDesktopCategories = publicRootCategories.filter((category) => category.id !== selectedDesktopCategory?.id);
  const popularDesktopCategories = [
    ...otherDesktopCategories.filter((category) => category.imageUrl),
    ...otherDesktopCategories.filter((category) => !category.imageUrl),
  ].slice(0, 2);

  function scheduleDesktopCategory(categoryId: string) {
    if (categoryHoverTimerRef.current) clearTimeout(categoryHoverTimerRef.current);
    categoryHoverTimerRef.current = setTimeout(() => setSelectedDesktopCategoryId(categoryId), 120);
  }

  function selectDesktopCategory(categoryId: string) {
    if (categoryHoverTimerRef.current) clearTimeout(categoryHoverTimerRef.current);
    setSelectedDesktopCategoryId(categoryId);
  }

  function moveCategoryFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      categoryMenuButtonRef.current?.focus();
      setCategoryMenuOpen(false);
      return;
    }
    const items = Array.from(categoryMenuRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []);
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLAnchorElement);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1 + items.length) % items.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== currentIndex) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  }

  return (
    <div className="storefront">
      {siteSettings.storefrontAnnouncement && <div className="storefront-announcement" role="status">{siteSettings.storefrontAnnouncement}</div>}
      <div className="storefront__utility">
        <div className="shell utility-bar">
          <div className="utility-bar__benefits" aria-label={`${siteSettings.storeName} marketplace benefits`}>
            <span><Icon name="badge-percent" size={13} />Wholesale prices</span>
            <span><Icon name="map-pin" size={13} />Global supply</span>
            <span><Icon name="truck" size={13} />Fast shipping</span>
            <span><Icon name="shield-check" size={13} />Secure payments</span>
            <span><Icon name="life-buoy" size={13} />Dedicated support</span>
          </div>
          <div ref={utilityMenuRef} className="utility-bar__controls" aria-label="Storefront settings">
            <div className="utility-control">
              <button
                type="button"
                ref={countryTriggerRef}
                className={`utility-control__trigger${utilityMenuOpen === "country" ? " is-active" : ""}`}
                aria-haspopup="dialog"
                aria-expanded={utilityMenuOpen === "country"}
                onClick={() => {
                  setUtilityMenuOpen((value) => value === "country" ? null : "country");
                  setCountrySearch("");
                }}
              >
                Ship to: {shipToCountry} <Icon name="chevron-down" size={11} />
              </button>
              {utilityMenuOpen === "country" && (
                <div className="utility-popover country-popover" role="dialog" aria-label="Choose a European country">
                  <div className="utility-popover__header">
                    <span className="utility-popover__eyebrow">Delivery preference</span>
                    <strong>Ship to</strong>
                    <p>Choose your preferred delivery country</p>
                  </div>
                  <label className="utility-popover__search">
                    <Icon name="search" size={13} />
                    <span className="visually-hidden">Search countries</span>
                    <input
                      autoFocus
                      value={countrySearch}
                      onChange={(event) => setCountrySearch(event.target.value)}
                      placeholder="Search countries"
                    />
                  </label>
                  <div className="utility-popover__list" role="listbox" aria-label="European countries">
                    {EUROPEAN_COUNTRY_NAMES
                      .filter((country) => country.toLowerCase().includes(countrySearch.trim().toLowerCase()))
                      .map((country) => (
                        <button
                          key={country}
                          type="button"
                          role="option"
                          aria-selected={shipToCountry === country}
                          className={shipToCountry === country ? "is-selected" : ""}
                          onClick={() => {
                            setShipToCountry(country);
                            closeUtilityMenu();
                          }}
                        >
                          <span className="utility-popover__country">
                            <span className="utility-popover__flag" aria-hidden="true">{EUROPEAN_COUNTRIES.find((item) => item.name === country)?.flag}</span>
                            <span>{country}</span>
                          </span>
                          {shipToCountry === country && <Icon name="check" size={13} />}
                        </button>
                      ))}
                  </div>
                  <p className="utility-popover__note">Preference only — shipping availability is confirmed at checkout.</p>
                </div>
              )}
            </div>
            <div className="utility-control">
              <button
                type="button"
                ref={languageTriggerRef}
                className={`utility-control__trigger${utilityMenuOpen === "language" ? " is-active" : ""}`}
                aria-haspopup="menu"
                aria-expanded={utilityMenuOpen === "language"}
                onClick={() => setUtilityMenuOpen((value) => value === "language" ? null : "language")}
              >
                EN <Icon name="chevron-down" size={11} />
              </button>
              {utilityMenuOpen === "language" && (
                <div className="utility-popover language-popover" role="menu" aria-label="Choose a language">
                  <div className="utility-popover__header">
                    <span className="utility-popover__eyebrow">Storefront language</span>
                    <strong>Language</strong>
                  </div>
                  {LANGUAGES.map((language) => (
                    <button key={language.code} type="button" role="menuitemradio" aria-checked={language.code === "EN"} className="is-selected" onClick={closeUtilityMenu}>
                      <span className="utility-popover__language"><span>{language.label}</span><small>{language.code}</small></span>
                      <Icon name="check" size={13} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <header className="storefront__header">
        <div className="mobile-storefront-header">
          <div className="mobile-storefront-header__top">
            <div className="mobile-storefront-header__identity">
              <BrandMark />
              <span className="mobile-storefront-header__tagline">Wholesale. Anytime. Everywhere.</span>
            </div>
            <div className="mobile-storefront-header__actions">
              <label className="mobile-country-picker" aria-label={`Ship to ${shipToCountry}`}>
                <Icon name="globe-2" size={18} />
                <span className="mobile-country-picker__divider" aria-hidden="true" />
                <strong className="mobile-country-picker__name">{shipToCountry}</strong>
                <Icon className="mobile-country-picker__chevron" name="chevron-down" size={14} />
                <select value={shipToCountry} onChange={(event) => setShipToCountry(event.target.value)} aria-label="Shipping destination">
                  {EUROPEAN_COUNTRY_NAMES.map((country) => <option key={country} value={country}>{country}</option>)}
                </select>
              </label>
              <Link className="mobile-storefront-cart" to="/cart" aria-label={`Cart, ${cartCount} items`}><Icon name="shopping-cart" size={21} /><b>{cartCount}</b></Link>
            </div>
          </div>
          <form className="mobile-storefront-search" onSubmit={submitSearch}>
            <Icon name="search" size={17} />
            <input ref={searchRef} aria-label="Search products by keyword" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products by keyword..." />
            <button className="mobile-storefront-search__scan" type="button" aria-label="Scan a product"><Icon name="camera" size={17} /></button>
            <button className="mobile-storefront-search__submit" type="submit">Search</button>
          </form>
          <nav className="mobile-storefront-nav" aria-label="Quick navigation">
             <button type="button" onClick={() => setMobileOpen(true)}><Icon name="layers-3" size={16} /> All Categories <Icon name="chevron-down" size={14} /></button>
            <Link to="/">Home</Link><Link to="/deals"><Icon name="sparkles" size={13} /> Hot Deals</Link><Link to="/new-arrivals">New</Link><Link className="mobile-storefront-nav__next" to="/categories" aria-label="Browse categories"><Icon name="arrow-right" size={15} /></Link>
          </nav>
        </div>
        <div className="shell header-main">
          <button
            ref={mobileMenuButtonRef}
            className="icon-button header-main__menu"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
          >
            <Icon name="menu" size={21} />
          </button>
          <BrandMark />
          <div className="header-category-menu header-main__categories">
            <button
              ref={categoryMenuButtonRef}
              type="button"
              aria-controls="category-navigation"
              aria-expanded={categoryMenuOpen}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setCategoryMenuOpen(true);
                }
              }}
              onClick={() => { setCategoryMenuOpen((value) => !value); setAccountMenuOpen(false); }}
            >
              <Icon name="layers-3" size={15} /> All categories <Icon name="chevron-down" size={14} />
            </button>
            {categoryMenuOpen && (
              <div ref={categoryMenuRef} id="category-navigation" className="header-popover category-popover" aria-label="Product categories" onKeyDown={moveCategoryFocus}>
                <nav className="category-mega__rail" aria-label="Departments">
                  <span className="category-mega__label">Categories</span>
                  <div className="category-mega__departments">
                    {publicRootCategories.map((category) => <Link
                      className={category.id === selectedDesktopCategory?.id ? "is-selected" : ""}
                      to={`/categories/${category.slug}`}
                      aria-current={category.id === selectedDesktopCategory?.id ? "true" : undefined}
                      onPointerEnter={() => scheduleDesktopCategory(category.id)}
                      onFocus={() => selectDesktopCategory(category.id)}
                      onClick={() => setCategoryMenuOpen(false)}
                      key={category.id}
                    >
                      <span className="category-mega__department-icon">{category.imageUrl ? <img src={category.imageUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="layers-3" size={17} />}</span>
                      <span className="category-popover__name">{category.publicName}</span>
                      <Icon name="chevron-down" size={14} />
                    </Link>)}
                  </div>
                </nav>
                {selectedDesktopCategory && <section className="category-mega__content" aria-labelledby="category-mega-heading">
                  <div className="category-mega__heading">
                    <h2 id="category-mega-heading">{selectedDesktopCategory.publicName}</h2>
                    <Link to={`/categories/${selectedDesktopCategory.slug}`} onClick={() => setCategoryMenuOpen(false)}>Shop all <Icon name="arrow-right" size={14} /></Link>
                  </div>
                  {selectedDesktopChildren.length > 0 ? <div className="category-mega__subcategories">
                    {selectedDesktopChildren.map((child) => <Link to={`/categories/${child.slug}`} onClick={() => setCategoryMenuOpen(false)} key={child.id}>
                      <span className="category-mega__subcategory-image">{child.imageUrl ? <img src={child.imageUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="layers-3" size={19} />}</span>
                      <span><strong>{child.publicName}</strong>{child.description?.trim() && <small>{child.description.trim()}</small>}</span>
                    </Link>)}
                  </div> : <div className="category-mega__empty">
                    <span className="category-mega__empty-image">{selectedDesktopCategory.imageUrl ? <img src={selectedDesktopCategory.imageUrl} alt={selectedDesktopCategory.publicName} loading="lazy" decoding="async" /> : <Icon name="layers-3" size={34} />}</span>
                    <div><strong>Explore {selectedDesktopCategory.publicName}</strong><p>Browse the complete collection and current availability.</p></div>
                  </div>}
                </section>}
                {selectedDesktopCategory && <aside className="category-mega__feature" aria-label={`${selectedDesktopCategory.publicName} feature`}>
                  <Link className={`category-mega__promo${selectedDesktopCategory.imageUrl ? " has-image" : ""}`} to={`/categories/${selectedDesktopCategory.slug}`} onClick={() => setCategoryMenuOpen(false)}>
                    {selectedDesktopCategory.imageUrl && <img src={selectedDesktopCategory.imageUrl} alt="" loading="lazy" decoding="async" />}
                    <span className="category-mega__promo-copy"><strong>Explore {selectedDesktopCategory.publicName}</strong><small>Browse current collections and availability</small><em>Shop {selectedDesktopCategory.publicName} <Icon name="arrow-right" size={13} /></em></span>
                  </Link>
                  <div className="category-mega__popular-heading"><strong>Popular now</strong><Link to="/categories" onClick={() => setCategoryMenuOpen(false)}>See all <Icon name="arrow-right" size={12} /></Link></div>
                  <div className="category-mega__popular">
                    {popularDesktopCategories.map((category) => <Link to={`/categories/${category.slug}`} onClick={() => setCategoryMenuOpen(false)} key={category.id}>
                      <span>{category.imageUrl ? <img src={category.imageUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="layers-3" size={22} />}</span>
                      <strong>{category.publicName}</strong>
                    </Link>)}
                  </div>
                </aside>}
                <Link className="category-popover__all" to="/categories" onClick={() => setCategoryMenuOpen(false)}>
                  <span><Icon name="layers-3" size={16} /> View all categories <Icon name="arrow-right" size={13} /></span>
                  <small>{publicRootCategories.length} {publicRootCategories.length === 1 ? "department" : "departments"}</small>
                </Link>
              </div>
            )}
          </div>
          <form className="header-main__search" onSubmit={submitSearch}>
            <Icon name="search" size={18} />
            <input ref={searchRef} aria-label="Search the catalog" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products, brands or categories" />
            <button className="header-search__submit" type="submit" aria-label="Search"><Icon name="search" size={17} /></button>
          </form>
          <div className="header-main__actions">
            <Link className="header-link header-link--deals" to="/deals">
              <Icon name="sparkles" size={20} />
              <span>Deals</span>
            </Link>
            <Link className="header-link header-link--wishlist" to="/wishlist" aria-label="Wishlist">
              <Icon name="heart" size={20} />
              <span>Wishlist</span>
            </Link>
            <div className="header-action-menu">
              <button className={`header-link header-link--account${accountMenuOpen ? " is-active" : ""}`} type="button" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => { setAccountMenuOpen((value) => !value); setCategoryMenuOpen(false); }}>
                <span className="header-account__icon"><Icon name="circle-user-round" size={20} />{signedIn && <i aria-hidden="true" />}</span>
                <span className="header-account__copy"><strong>{authLoading ? "Account" : signedIn ? `Hi, ${customerName}` : "Sign in"}</strong><small>{signedIn ? "Account" : "Customer account"}</small></span>
              </button>
              {accountMenuOpen && <div className="header-popover account-popover" role="menu">{signedIn ? <><div className="account-popover__identity"><span className="account-status-dot" aria-hidden="true" /><div><strong>{customerName}</strong><small>Signed in</small></div></div><Link to="/account" role="menuitem" onClick={() => setAccountMenuOpen(false)}>My account</Link><Link to="/account/orders" role="menuitem" onClick={() => setAccountMenuOpen(false)}>My orders</Link><Link to="/wishlist" role="menuitem" onClick={() => setAccountMenuOpen(false)}>My wishlist</Link><Link to="/support" role="menuitem" onClick={() => setAccountMenuOpen(false)}>Support</Link><Link to="/chat" role="menuitem" onClick={() => setAccountMenuOpen(false)}>Live chat</Link><button className="account-popover__signout" role="menuitem" type="button" onClick={() => void signOut()}><Icon name="log-out" size={15} /> Sign out</button></> : <><div className="account-popover__identity"><div><strong>Customer account</strong><small>Sign in to view orders and account details</small></div></div><Link to="/login" role="menuitem" onClick={() => setAccountMenuOpen(false)}>Sign in</Link><Link to="/register" role="menuitem" onClick={() => setAccountMenuOpen(false)}>Create account</Link><Link to="/support" role="menuitem" onClick={() => setAccountMenuOpen(false)}>Support</Link></>}</div>}
            </div>
            <Link className="cart-link" to="/cart">
              <Icon name="shopping-bag" size={20} />
              <span>Cart</span>
               <b>{cartCount}</b>
            </Link>
          </div>
        </div>
        <div className="shell header-nav">
          <nav aria-label="Main navigation">
            <NavLink to="/shop" className={({ isActive }) => isActive ? "is-active" : ""}>Best Sellers</NavLink>
            <NavLink to="/new-arrivals" className={({ isActive }) => isActive ? "is-active" : ""}>New Arrivals</NavLink>
            <NavLink to="/deals" className={({ isActive }) => isActive ? "is-active" : ""}>Deals</NavLink>
            <NavLink to="/chat" className={({ isActive }) => isActive ? "is-active" : ""}>Live Chat</NavLink>
          </nav>
          <Link className="business-link" to="/start-a-business">Start a business <Icon name="arrow-up-right" size={15} /></Link>
        </div>
      </header>

      {mobileOpen && (
        <div className="mobile-drawer__backdrop" onClick={() => setMobileOpen(false)}>
          <aside ref={mobileDrawerRef} className="mobile-drawer" role="dialog" aria-modal="true" aria-labelledby="mobile-navigation-title" onClick={(event) => event.stopPropagation()}>
            <div className="mobile-drawer__top">
              <BrandMark />
              <button ref={mobileCloseButtonRef} className="icon-button" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
                <Icon name="x" size={21} />
              </button>
            </div>
            <p id="mobile-navigation-title" className="mobile-drawer__kicker">Wholesale. Anytime. Everywhere.</p>
            <div className={`mobile-account-state${signedIn ? " is-signed-in" : ""}`}>
              <span className="mobile-account-state__icon"><Icon name="circle-user-round" size={21} />{signedIn && <i aria-hidden="true" />}</span>
              <div><strong>{signedIn ? `Hi, ${customerName}` : "Not signed in"}</strong><small>{signedIn ? "Your customer account" : "Sign in to access your account"}</small></div>
            </div>
             <form className="mobile-drawer__search header-main__search" onSubmit={(event) => { submitSearch(event); setMobileOpen(false); }}>
              <Icon name="search" size={18} />
               <input aria-label="Search the catalog" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the catalog" />
             </form>
            <nav aria-label="Mobile navigation" className="mobile-drawer__nav">
              {customerNavigation.map((item) => (
                <NavLink key={item.path} to={item.path} onClick={() => setMobileOpen(false)}>
                  <Icon name={item.icon as "shopping-bag"} size={18} /> {item.label}
                </NavLink>
              ))}
              <NavLink to="/start-a-business" onClick={() => setMobileOpen(false)}>
                <Icon name="building-2" size={18} /> Start a business
              </NavLink>
                <LegalNavigation location="mobile" />
            </nav>
             <div className="mobile-drawer__categories">
               <span className="mobile-drawer__categories-label">Shop by category</span>
               {publicRootCategories.map((category) => {
                 const children = categoryChildren(category.id);
                 const expanded = expandedMobileCategories.includes(category.id);
                 return <div className="mobile-drawer__category-group" key={category.id}>
                   <div className="mobile-drawer__category-row">
                     <Link to={`/categories/${category.slug}`} onClick={() => setMobileOpen(false)}>
                       <Icon name="layers-3" size={17} /> <span>{category.publicName}</span> <Icon className="mobile-drawer__category-arrow" name="arrow-right" size={14} />
                     </Link>
                     {children.length > 0 && <button type="button" className="mobile-drawer__category-disclosure" aria-expanded={expanded} aria-controls={`mobile-category-${category.id}`} aria-label={`${expanded ? "Collapse" : "Expand"} ${category.publicName} subcategories`} onClick={() => setExpandedMobileCategories((current) => expanded ? current.filter((id) => id !== category.id) : [...current, category.id])}><Icon name="chevron-down" size={15} /></button>}
                   </div>
                   {children.length > 0 && expanded && <div className="mobile-drawer__category-children" id={`mobile-category-${category.id}`} aria-label={`${category.publicName} subcategories`}>{children.map((child) => <Link key={child.id} to={`/categories/${child.slug}`} onClick={() => setMobileOpen(false)}><span aria-hidden="true" /><span>{child.publicName}</span><Icon className="mobile-drawer__category-arrow" name="arrow-right" size={13} /></Link>)}</div>}
                 </div>;
               })}
               <Link to="/categories" onClick={() => setMobileOpen(false)}><Icon name="layers-3" size={17} /> <span>Browse all categories</span> <Icon className="mobile-drawer__category-arrow" name="arrow-up-right" size={14} /></Link>
             </div>
            <div className="mobile-drawer__secondary">
              <Link to={signedIn ? "/account" : "/login"} onClick={() => setMobileOpen(false)}><Icon name="circle-user-round" size={18} /> {signedIn ? "My account" : "Sign in"}</Link>
              <Link to="/wishlist" onClick={() => setMobileOpen(false)}><Icon name="heart" size={18} /> Wishlist</Link>
              {signedIn && <Link to="/account/orders" onClick={() => setMobileOpen(false)}><Icon name="receipt-text" size={18} /> Orders</Link>}
              {signedIn && <Link to="/account/notifications" onClick={() => setMobileOpen(false)}><Icon name="bell" size={18} /> Notifications{unreadNotifications > 0 && <b className="mobile-notification-count">{unreadNotifications}</b>}</Link>}
              <Link to="/support" onClick={() => setMobileOpen(false)}><Icon name="life-buoy" size={18} /> Support</Link>
              <Link to="/chat" onClick={() => setMobileOpen(false)}><Icon name="life-buoy" size={18} /> Live chat</Link>
              {signedIn && <button className="mobile-account-signout" type="button" onClick={() => void signOut()}><Icon name="log-out" size={18} /> Sign out</button>}
            </div>
          </aside>
        </div>
      )}

      <main key={location.pathname}>{children}</main>

      <nav className="mobile-bottom-nav" aria-label="Mobile storefront navigation">
        <Link className={location.pathname === "/" ? "is-active" : ""} to="/"><Icon name="house" size={19} /><span>Home</span></Link>
        <Link className={location.pathname.startsWith("/categories") ? "is-active" : ""} to="/categories"><Icon name="layers-3" size={19} /><span>Categories</span></Link>
        <Link className={location.pathname === "/cart" ? "is-active" : ""} to="/cart"><span className="mobile-bottom-nav__icon"><Icon name="shopping-bag" size={19} /><b>{cartCount}</b></span><span>Cart</span></Link>
        <Link className={location.pathname.startsWith("/account") || location.pathname === "/login" ? "is-active" : ""} to={signedIn ? "/account" : "/login"}><Icon name="circle-user-round" size={19} /><span>{signedIn ? "Account" : "Sign in"}</span></Link>
      </nav>

      <footer id="storefront-footer" className="storefront__footer">
        <div className="shell footer-grid">
          <div className="footer-brand">
            <BrandMark light />
            <p className="footer-intro"><strong>Wholesale. Anytime. Everywhere.</strong><br />Clear pricing, availability, and order progress.</p>
          </div>
          <div className={`footer-column${openFooterSection === "marketplace" ? " is-open" : ""}`}>
            <span className="footer-label">Marketplace</span>
            <button type="button" className="footer-accordion-trigger" aria-expanded={openFooterSection === "marketplace"} aria-controls="footer-marketplace" onClick={() => setOpenFooterSection((current) => current === "marketplace" ? null : "marketplace")}><span>Marketplace</span><Icon name="chevron-down" size={17} /></button>
            <div className="footer-column__links" id="footer-marketplace">
              <Link to="/shop">Shop</Link>
              <Link to="/categories">Categories</Link>
              <Link to="/new-arrivals">New arrivals</Link>
              <Link to="/deals">Featured picks</Link>
              <Link to="/brands">Brands</Link>
            </div>
          </div>
          <div className={`footer-column${openFooterSection === "account" ? " is-open" : ""}`}>
            <span className="footer-label">Company</span>
            <button type="button" className="footer-accordion-trigger" aria-expanded={openFooterSection === "account"} aria-controls="footer-account" onClick={() => setOpenFooterSection((current) => current === "account" ? null : "account")}><span>Account</span><Icon name="chevron-down" size={17} /></button>
            <div className="footer-column__links" id="footer-account">
              <Link to="/account">My account</Link>
              <Link to="/account/orders">Orders &amp; tracking</Link>
              <Link to="/wishlist">Wishlist</Link>
            </div>
          </div>
          <div className={`footer-column${openFooterSection === "support" ? " is-open" : ""}`}>
            <span className="footer-label">Support</span>
            <button type="button" className="footer-accordion-trigger" aria-expanded={openFooterSection === "support"} aria-controls="footer-support" onClick={() => setOpenFooterSection((current) => current === "support" ? null : "support")}><span>Support</span><Icon name="chevron-down" size={17} /></button>
            <div className="footer-column__links" id="footer-support">
              <Link to="/support">Support</Link>
              <Link to="/account/orders">Order tracking</Link>
              <Link className="footer-contact-link footer-mobile-only" to="/chat"><Icon name="messages-square" size={14} /> Live Chat</Link>
            </div>
          </div>
          <div className={`footer-column${openFooterSection === "contact" ? " is-open" : ""}`}>
            <span className="footer-label">Stay in touch</span><span className="footer-contact-compat">Contact</span>
            <button type="button" className="footer-accordion-trigger" aria-expanded={openFooterSection === "contact"} aria-controls="footer-contact" onClick={() => setOpenFooterSection((current) => current === "contact" ? null : "contact")}><span>Stay in touch</span><Icon name="chevron-down" size={17} /></button>
            <div className="footer-column__links" id="footer-contact">
              <Link to="/brands">Browse brands</Link>
              <Link to="/start-a-business">Start a business</Link>
              <Link to="/support">Support center</Link>
              <Link className="footer-contact-link footer-desktop-only" to="/chat"><Icon name="messages-square" size={14} /> Live Chat</Link>
              <LegalNavigation location="footer" />
              <button type="button" className="footer-link-button" onClick={() => window.dispatchEvent(new Event("lizzor:open-cookie-settings"))}>Cookie settings</button>
            </div>
          </div>
        </div>
        <div className="shell footer-bottom">
          <span>© 2026 Lizzor</span>
          <span>Wholesale. Anytime. Everywhere.</span>
        </div>
      </footer>
      <CookieConsent />
    </div>
  );
}