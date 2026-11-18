import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { Icon } from "../../components/ui/Icon";
import { useWishlist } from "../../components/storefront/WishlistContext";
import { useSeoMeta } from "../../components/seo/SeoMeta";
import { publicBrandName, publicCategories, publicCategoryChildren, publicCategoryDescription, publicCategoryName, publicProductName } from "../../components/storefront/publicDisplay";
import { productCardTierMessages, selectSellableProducts } from "./productCardPresentation";
import { responsiveBannerSources } from "./bannerPresentation";
import { isQuantityInTier, quantityForTier } from "./quantityTierSelection";
import mobileWarehouseHero from "../../../attached_assets/generated_images/lizzor-mobile-warehouse-hero.png";

type Availability = "in_stock" | "low_stock" | "out_of_stock";
type Category = { id: string; parentId?: string | null; name: string; slug: string; description?: string | null; imageUrl?: string | null; seoTitle?: string | null; seoDescription?: string | null };
type Brand = { id: string; name: string; slug: string; description?: string | null; logoUrl?: string | null; seoTitle?: string | null; seoDescription?: string | null };
type Tier = { id: string; minQuantity: number; maxQuantity: number | null; unitPrice: number };
type StorefrontBanner = {
  slot: "homepage_hero" | "homepage_app_banner";
  desktopUrl: string | null;
  mobileUrl: string | null;
  altText: string | null;
  enabled: boolean;
  appStatus: "coming_soon" | "live";
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  qrImageUrl: string | null;
};
export type ProductCard = {
  id: string; name: string; slug: string; parentSku: string; brand: Brand | null;
  category: { id: string; name: string; slug: string }; shortDescription?: string | null; price: number;
  nextTier: { minQuantity: number; unitPrice: number; additionalQuantity: number } | null;
  homepageWholesaleOffer: { minQuantity: number; unitPrice: number; additionalQuantity: number } | null;
  available: number; availability: Availability; featured: boolean; homepageWholesale: boolean; newArrival: boolean;
  thumbnailUrl?: string | null; thumbnailAltText?: string | null; variantCount: number; wishlisted: boolean;
  promotionalPrice?: number | null; promotion?: { name?: string; discount: number } | null; seoTitle?: string | null; seoDescription?: string | null;
};
type HomepageProducts = {
  bestSellers: ProductCard[];
  liveWholesalePricing: ProductCard[];
};
type Product = ProductCard & {
  description: string; vatRate: number; media: Array<{ id: string; type: string; url: string; altText?: string | null; variantId?: string | null }>;
  options: string[]; tiers: Tier[]; variants: Array<{
    id: string; sku: string; title: string; basePrice: number | null; optionValues: Array<{ attribute: string; value: string }>;
    price: number; tiers: Tier[]; available: number; availability: Availability; media: Product["media"];
    promotionalPrice?: number | null; promotion?: { name?: string; discount: number } | null;
  }>;
};

const money = (value: number, currency = "EUR") => new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
const unwrap = <T,>(response: { data: T }) => response.data;

function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return <nav className="breadcrumb" aria-label="Breadcrumb"><Link to="/">Home</Link>{items.map((item) => <span className="breadcrumb__item" key={item.label}><Icon name="arrow-right" size={13} />{item.to ? <Link to={item.to}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}</span>)}</nav>;
}

function categoryTrail(category: Category, categories: Category[] | null): Category[] {
  const trail: Category[] = [category];
  let parentId = category.parentId;
  const seen = new Set([category.id]);
  while (parentId && categories) {
    const parent = categories.find((item) => item.id === parentId);
    if (!parent || seen.has(parent.id)) break;
    trail.unshift(parent); seen.add(parent.id); parentId = parent.parentId;
  }
  return trail;
}

function categoryCrumbs(category: Category, categories: Category[] | null): Array<{ label: string; to?: string }> {
  const trail = categoryTrail(category, categories);
  return trail.flatMap((item, index) => {
    const label = publicCategoryName(item.name);
    return label ? [{ label, to: index === trail.length - 1 ? undefined : `/categories/${item.slug}` }] : [];
  });
}

function ProductImage({ product, large = false }: { product: Pick<ProductCard, "name" | "thumbnailUrl" | "thumbnailAltText">; large?: boolean }) {
  return product.thumbnailUrl
    ? <img className={large ? "product-image product-image--large" : "product-image"} src={product.thumbnailUrl} alt={product.thumbnailAltText || product.name} loading={large ? "eager" : "lazy"} decoding="async" />
    : <div className={`product-image product-image--placeholder ${large ? "product-image--large" : ""}`} aria-label={`${product.name} image unavailable`}><Icon name="package" size={large ? 38 : 26} /><span>Lizzor catalog / media pending</span></div>;
}

function Availability({ value, available }: { value: Availability; available?: number }) {
  const labels: Record<Availability, string> = { in_stock: "In stock", low_stock: "Low stock", out_of_stock: "Out of stock" };
  return <span className={`availability-pill availability-pill--${value}`}><i />{labels[value]}{value === "low_stock" && available !== undefined ? ` · ${available} left` : ""}</span>;
}

function WishlistButton({ productId, initialSaved }: { productId: string; initialSaved: boolean }) {
  const { isSaved, toggle } = useWishlist();
  const [busy, setBusy] = useState(false);
  const saved = isSaved(productId, initialSaved);
  async function onToggle(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try { await toggle(productId, initialSaved); } finally { setBusy(false); }
  }
  return <button className={`wishlist-button${saved ? " is-saved" : ""}`} type="button" aria-label={saved ? "Remove from wishlist" : "Add to wishlist"} aria-pressed={saved} disabled={busy} onClick={(event) => void onToggle(event)}><Icon name="heart" size={17} /></button>;
}

function ProductCardView({ product, onQuickAdd }: { product: ProductCard; onQuickAdd?: (product: ProductCard) => void | Promise<void> }) {
  const categoryLabel = publicCategoryName(product.category.name);
  const productName = publicProductName(product.name);
  const description = product.shortDescription?.trim() || "";
  const tierMessages = productCardTierMessages(product, money);
  return <article className="catalog-card">
      <div className="catalog-card__media-wrap"><Link className="catalog-card__media" to={`/products/${product.slug}`}><ProductImage product={product} />{product.promotionalPrice !== null && product.promotionalPrice !== undefined ? <span className="catalog-card__badge">Sale</span> : product.newArrival ? <span className="catalog-card__badge">New</span> : product.featured ? <span className="catalog-card__badge">Best Seller</span> : null}</Link><WishlistButton productId={product.id} initialSaved={product.wishlisted} /></div>
    <div className="catalog-card__body">
       <div className="catalog-card__meta">{product.brand ? <Link to={`/brands/${product.brand.slug}`}>{publicBrandName(product.brand.name)}</Link> : categoryLabel ? <span>{categoryLabel}</span> : null}</div>
       <Link className="catalog-card__title-link" to={`/products/${product.slug}`}><h2>{productName}</h2></Link>
       <p className={`catalog-card__description${description ? "" : " is-empty"}`} aria-hidden={!description}>{description || " "}</p>
      <div className="catalog-card__price"><strong>{money(product.promotionalPrice ?? product.price)}</strong>{product.promotionalPrice !== null && product.promotionalPrice !== undefined && <del>{money(product.price)}</del>}<span>per unit</span></div>
       <div className={`catalog-card__tier-slot${tierMessages.length ? "" : " is-empty"}`} aria-hidden={!tierMessages.length}>{tierMessages.length ? tierMessages.map((message) => <span key={message}>{message}</span>) : " "}</div>
       <div className="catalog-card__footer"><Availability value={product.availability} available={product.available} />{product.variantCount === 0 ? <button className="button button--quiet button--small catalog-card__action" aria-label="Add to cart" disabled={!onQuickAdd || product.availability === "out_of_stock"} onClick={() => { if (onQuickAdd) void onQuickAdd(product); }}><Icon name="shopping-bag" size={12} /><span className="catalog-card__action-label">Add to cart</span></button> : <Link className="button button--quiet button--small catalog-card__action" aria-label="Choose options" to={`/products/${product.slug}`}><Icon name="shopping-bag" size={12} /><span className="catalog-card__action-label">Choose options</span></Link>}</div>
    </div>
  </article>;
}

function CatalogLoading() {
  return <div className="catalog-grid catalog-grid--skeleton">{[1, 2, 3, 4].map((item) => <div className="catalog-skeleton" key={item}><i /><b /><span /><span /></div>)}</div>;
}

function CatalogError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="storefront-state storefront-state--error"><Icon name="circle-help" size={24} /><h2>We couldn’t load the catalog</h2><p>{message}</p><button className="button button--dark" onClick={retry}>Try again</button></div>;
}

function useCatalogData() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [brands, setBrands] = useState<Brand[] | null>(null);
  useEffect(() => {
    Promise.all([
      apiRequest<{ data: Category[] }>("/catalog/categories").then(unwrap),
      apiRequest<{ data: Brand[] }>("/catalog/brands").then(unwrap),
    ]).then(([nextCategories, nextBrands]) => { setCategories(nextCategories); setBrands(nextBrands); }).catch(() => { setCategories([]); setBrands([]); });
  }, []);
  return { categories, brands };
}

function ResponsiveBannerImage({ banner, fallback, mobileOverride, eager = false, alt }: {
  banner: StorefrontBanner | undefined;
  fallback: string;
  mobileOverride?: string;
  eager?: boolean;
  alt?: string;
}) {
  const { desktopUrl, mobileUrl } = responsiveBannerSources(banner?.desktopUrl, banner?.mobileUrl, fallback);
  return <picture>
    <source media="(max-width: 680px)" srcSet={mobileOverride ?? mobileUrl} />
    <img src={desktopUrl} alt={banner?.altText ?? alt ?? ""} loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : "auto"} decoding="async" />
  </picture>;
}

function categoryImageClass(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("electronics")) return "home-category-card__image--electronics";
  if (normalized.includes("home") || normalized.includes("kitchen")) return "home-category-card__image--home-kitchen";
  if (normalized.includes("beauty") || normalized.includes("personal care")) return "home-category-card__image--beauty";
  if (normalized.includes("travel") || normalized.includes("accessories")) return "home-category-card__image--travel";
  if (normalized.includes("office")) return "home-category-card__image--office";
  return "";
}

function categoryHeroImageClass(name: string) {
  const normalized = publicCategoryName(name)?.toLowerCase() ?? name.toLowerCase();
  if (normalized.includes("electronics")) return "category-hero__image--electronics";
  if (normalized.includes("home") || normalized.includes("kitchen")) return "category-hero__image--home-kitchen";
  if (normalized.includes("beauty") || normalized.includes("personal care")) return "category-hero__image--beauty";
  if (normalized.includes("travel") || normalized.includes("accessories")) return "category-hero__image--travel";
  if (normalized.includes("office")) return "category-hero__image--office";
  return "";
}

export function HomePage() {
  const location = useLocation();
  const [homepageProducts, setHomepageProducts] = useState<HomepageProducts | null>(null);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [banners, setBanners] = useState<StorefrontBanner[]>([]);
  const [homeSections, setHomeSections] = useState<Array<{ key: string; sortOrder: number }>>([
    { key: "hero", sortOrder: 10 }, { key: "best_sellers", sortOrder: 20 }, { key: "deals", sortOrder: 30 },
    { key: "categories", sortOrder: 40 }, { key: "why_lizzor", sortOrder: 50 }, { key: "app_banner", sortOrder: 60 },
  ]);
  const [quickFeedback, setQuickFeedback] = useState("");
  const [error, setError] = useState("");
  useSeoMeta({ title: "Wholesale catalog", description: "Browse Lizzor's live wholesale catalog with quantity pricing, stock visibility, and order tracking.", canonicalPath: "/" });
  useEffect(() => {
    Promise.all([
      apiRequest<{ data: HomepageProducts }>("/storefront/homepage-products").then(unwrap),
      apiRequest<{ data: Category[] }>("/catalog/categories").then(unwrap),
    ]).then(([nextHomepageProducts, nextCategories]) => { setHomepageProducts(nextHomepageProducts); setCategories(nextCategories); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Please try again."));
  }, []);
  useEffect(() => {
    apiRequest<{ data: StorefrontBanner[] }>("/storefront/banners")
      .then((response) => setBanners(response.data))
      .catch(() => setBanners([]));
  }, []);
  useEffect(() => {
    apiRequest<{ data: Array<{ key: string; sortOrder: number }> }>("/storefront/homepage-sections")
      .then((response) => setHomeSections(response.data))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const selectors: Record<string, string> = {
      hero: ".storefront-home__hero",
      best_sellers: "#featured-products",
      deals: "#live-pricing",
      categories: "#shop-categories",
      why_lizzor: ".home-why",
      app_banner: "#mobile-apps",
    };
    for (const [key, selector] of Object.entries(selectors)) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) continue;
      const section = homeSections.find((item) => item.key === key);
      element.style.display = section ? "" : "none";
      element.style.order = String(section?.sortOrder ?? 999);
    }
    const valueStrip = document.querySelector<HTMLElement>(".home-value-strip");
    if (valueStrip) {
      const hero = homeSections.find((item) => item.key === "hero");
      valueStrip.style.display = hero ? "" : "none";
      valueStrip.style.order = String((hero?.sortOrder ?? 998) + 1);
    }
  }, [homeSections, homepageProducts, categories, banners]);
  useEffect(() => {
    const targetId = location.hash.slice(1);
    if (!targetId) return;
    const timeout = window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ block: "start" }), 120);
    return () => window.clearTimeout(timeout);
  }, [categories, location.hash, homepageProducts]);
  async function quickAdd(product: ProductCard) {
    try {
      await apiRequest("/cart/items", { method: "POST", body: JSON.stringify({ productId: product.id, quantity: 1 }) });
      setQuickFeedback(`${product.name} added to your cart.`);
    } catch (reason) {
      setQuickFeedback(reason instanceof Error ? reason.message : "This item could not be added.");
    }
  }
  const bestProducts = selectSellableProducts(homepageProducts?.bestSellers ?? []);
  const wholesaleProducts = selectSellableProducts(homepageProducts?.liveWholesalePricing ?? []);
  const homepageRoots = publicCategories((categories ?? []).filter((category) => !category.parentId));
  const preferredNames = ["home & kitchen", "electronics", "beauty & personal care", "travel & luggage"];
  const preferredCategories = preferredNames.flatMap((name) => homepageRoots.filter((category) => category.publicName.toLowerCase() === name));
  const visibleCategories = homepageRoots.slice(0, 6);
  const mobileFeaturedCategories = [...preferredCategories, ...homepageRoots.filter((category) => !preferredCategories.some((preferred) => preferred.id === category.id))].slice(0, 4);
  const heroBanner = banners.find((banner) => banner.slot === "homepage_hero");
  const appBanner = banners.find((banner) => banner.slot === "homepage_app_banner");
  const sectionOrder = (key: string) => homeSections.find((section) => section.key === key)?.sortOrder;
  const sectionStyle = (key: string) => ({ order: sectionOrder(key) ?? 999, display: sectionOrder(key) === undefined ? "none" : undefined });
  return <div className="storefront-page storefront-home">
    <section className="storefront-home__hero" style={sectionStyle("hero")}><div className="shell storefront-home__hero-inner">
      <div className="storefront-home__hero-copy"><span className="eyebrow">Wholesale marketplace</span><h1>Wholesale.<br />{" "}Anytime.<br />{" "}<em>Everywhere.</em></h1><p>Live products, clear wholesale pricing, and availability context for every order.</p><div className="hero-actions"><Link className="button home-hero__primary" to="/shop">Shop now <Icon name="arrow-right" size={16} /></Link><Link className="button home-hero__secondary" to="/categories">Explore categories</Link></div><div className="home-hero__proof"><span><Icon name="truck" size={16} /><span><strong>Fast shipping</strong><small>Worldwide</small></span></span><span><Icon name="shield-check" size={16} /><span><strong>Secure payments</strong><small>Shop with confidence</small></span></span><span><Icon name="boxes" size={16} /><span><strong>Global supply</strong><small>Wide product range</small></span></span></div></div>
       <div className="storefront-home__hero-art" aria-label={heroBanner?.altText ? undefined : "Lizzor global wholesale catalog"}><ResponsiveBannerImage banner={heroBanner} fallback="/lizzor-hero-art.png" mobileOverride={mobileWarehouseHero} eager /></div>
    </div></section>
    <section className="mobile-promo-grid" style={sectionOrder("hero") === undefined ? { display: "none" } : { order: (sectionOrder("hero") ?? 10) + 1 }} aria-label="Business services">
        <Link className="mobile-promo-card mobile-promo-card--green" to="/start-a-business"><Icon name="boxes" size={24} /><strong>Bulk Wholesale</strong><span>Tiered pricing for bulk orders</span><em>Get quote <Icon name="arrow-right" size={13} /></em></Link>
        <Link className="mobile-promo-card mobile-promo-card--lavender" to="/categories"><Icon name="warehouse" size={24} /><strong>Find Products for Your Business</strong><span>We source from trusted factories</span><em>Learn more <Icon name="arrow-right" size={13} /></em></Link>
    </section>
    <section className="mobile-benefit-card" style={sectionOrder("hero") === undefined ? { display: "none" } : { order: (sectionOrder("hero") ?? 10) + 2 }} aria-label="Why shop Lizzor">
        <div><Icon name="truck" size={19} /><strong>Fast shipping</strong><span>Worldwide</span></div>
        <div><Icon name="shield-check" size={19} /><strong>Secure payments</strong><span>Shop with confidence</span></div>
        <div><Icon name="boxes" size={19} /><strong>Wide range</strong><span>Millions of products</span></div>
        <div><Icon name="life-buoy" size={19} /><strong>Dedicated support</strong><span>Here to help</span></div>
    </section>
    <div className="shell">
      <section className="home-value-strip" aria-label="Marketplace benefits"><div><Icon name="boxes" size={24} /><span><strong>Live catalog</strong><small>Live product stock</small></span></div><div><Icon name="badge-percent" size={24} /><span><strong>Quantity pricing</strong><small>Quantity tier context</small></span></div><div><Icon name="truck" size={24} /><span><strong>Shipping choices</strong><small>Order-based options</small></span></div><div><Icon name="shield-check" size={24} /><span><strong>Order visibility</strong><small>Account order progress</small></span></div></section>
      {error && <div className="commerce-notice commerce-notice--negative home-load-error"><Icon name="circle-help" size={16} /><span>Some homepage content could not be loaded.</span><button type="button" onClick={() => window.location.reload()}>Try again</button></div>}
     {quickFeedback && <div className="commerce-notice commerce-notice--positive home-quick-feedback"><Icon name="check" size={16} />{quickFeedback}<Link className="text-link" to="/cart">View cart <Icon name="arrow-right" size={14} /></Link></div>}
       {homepageProducts !== null && bestProducts.length > 0 && <section id="featured-products" className="home-section home-section--compact-products"><div className="home-reference-heading"><h2>Best Sellers</h2><Link to="/shop">View all <Icon name="arrow-right" size={14} /></Link></div><div className="catalog-grid home-product-grid">{bestProducts.map((product) => <ProductCardView product={product} onQuickAdd={quickAdd} key={product.id} />)}</div></section>}
      {error ? <section id="live-pricing" className="home-section home-deals"><CatalogError message={error} retry={() => window.location.reload()} /></section> : homepageProducts === null ? <section id="live-pricing" className="home-section home-deals"><CatalogLoading /></section> : wholesaleProducts.length ? <section id="live-pricing" className="home-section home-deals"><div className="home-reference-heading"><h2>Live wholesale pricing</h2><Link to="/shop">View all <Icon name="arrow-right" size={14} /></Link></div><div className="home-deals__grid">{wholesaleProducts.map((product, index) => {
          const categoryLabel = publicCategoryName(product.category.name);
        return <Link className={`home-deal-card home-deal-card--${index + 1}`} to={`/products/${product.slug}`} key={product.id}>
          <div className="home-deal-card__copy">
              {categoryLabel && <span>{categoryLabel}</span>}
            <h3>{publicProductName(product.name)}</h3>
            <p>{product.shortDescription || "View live availability and wholesale pricing."}</p>
             <strong>{money(product.price)}<small>per unit</small></strong>
            {product.homepageWholesaleOffer && <small className="home-deal-card__tier">From {product.homepageWholesaleOffer.minQuantity} units · {money(product.homepageWholesaleOffer.unitPrice)} each</small>}
             <em>View product <Icon name="arrow-right" size={12} /></em>
          </div>
          <ProductImage product={product} />
        </Link>;
       })}</div></section> : null}
        {categories !== null && visibleCategories.length > 0 && <section id="shop-categories" className="home-section home-categories"><div className="home-reference-heading"><h2>Shop by category</h2><Link to="/categories">View all categories <Icon name="arrow-right" size={14} /></Link></div><div className="home-category-grid home-category-grid--desktop">{visibleCategories.map((category) => <Link className="home-category-card" to={`/categories/${category.slug}`} key={category.id}>{category.imageUrl ? <img className={`home-category-card__image ${categoryImageClass(category.publicName)}`} src={category.imageUrl} alt={category.publicName} loading="lazy" decoding="async" /> : <div><Icon name="layers-3" size={31} /></div>}<strong>{category.publicName}</strong><small>Explore products</small></Link>)}</div><div className="home-category-grid home-category-grid--mobile">{mobileFeaturedCategories.map((category) => <Link className="home-category-card" to={`/categories/${category.slug}`} key={category.id}>{category.imageUrl ? <img className={`home-category-card__image ${categoryImageClass(category.publicName)}`} src={category.imageUrl} alt={category.publicName} loading="lazy" decoding="async" /> : <div><Icon name="layers-3" size={31} /></div>}<strong>{category.publicName}</strong><small>Explore products</small></Link>)}<Link className="home-category-card home-category-card--all" to="/categories"><div><Icon name="layout-dashboard" size={30} /></div><strong>Explore all categories</strong><small>Discover the full range</small></Link></div></section>}
      <section className="home-why" aria-labelledby="home-why-title"><h2 id="home-why-title">Why businesses choose <span>Lizzor</span></h2><div className="home-why__grid"><div><span className="home-why__icon"><Icon name="badge-percent" size={25} /></span><strong>Wholesale pricing</strong><small>Quantity tiers shown while you shop</small></div><div><span className="home-why__icon"><Icon name="boxes" size={25} /></span><strong>Catalog availability</strong><small>Stock context for every product</small></div><div><span className="home-why__icon"><Icon name="truck" size={25} /></span><strong>Shipping &amp; tracking</strong><small>Order-based options and progress</small></div><div><span className="home-why__icon"><Icon name="shield-check" size={25} /></span><strong>Supported payments</strong><small>Checkout uses supported payment flows</small></div><div><span className="home-why__icon"><Icon name="undo-2" size={25} /></span><strong>Returns workflow</strong><small>Start eligible returns from your account</small></div><div><span className="home-why__icon"><Icon name="life-buoy" size={25} /></span><strong>Business support</strong><small>Get help with your business order</small></div></div></section>
         <section id="mobile-apps" className="home-app-promo home-app-promo--artwork" aria-label={appBanner?.altText ?? "Lizzor mobile app coming soon"}>
           <ResponsiveBannerImage banner={appBanner} fallback="/lizzor-mobile-app-banner.png" eager alt="Lizzor mobile app coming soon banner" />
         </section>
  </div></div>;
}

export function CatalogPage({ mode = "all", category, brand }: { mode?: "all" | "new" | "deals"; category?: Category; brand?: Brand }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { categories, brands } = useCatalogData();
  const [result, setResult] = useState<{ items: ProductCard[]; meta: { page: number; pageSize: number; total: number; hasNext: boolean } } | null>(null);
  const [error, setError] = useState("");
  const [quickFeedback, setQuickFeedback] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const search = searchParams.get("q") ?? "";
  const page = Number(searchParams.get("page") ?? 1);
  const categoryId = category?.id ?? searchParams.get("category") ?? "";
  const brandId = brand?.id ?? searchParams.get("brand") ?? "";
  const minPrice = searchParams.get("minPrice") ?? "";
  const maxPrice = searchParams.get("maxPrice") ?? "";
  const availability = searchParams.get("availability") ?? "";
  const sort = searchParams.get("sort") ?? (mode === "new" ? "created" : "updated");
  const direction = searchParams.get("direction") ?? (sort === "name" || sort === "price" ? "asc" : "desc");
  const activeFilterCount = [categoryId, brandId, minPrice, maxPrice, availability].filter(Boolean).length;
  const endpoint = useMemo(() => {
    const query = new URLSearchParams({ page: String(Number.isFinite(page) && page > 0 ? page : 1), pageSize: "12", sort, direction });
    if (search) query.set("search", search);
    if (categoryId) query.set("categoryId", categoryId);
    if (brandId) query.set("brandId", brandId);
    if (minPrice) query.set("minPrice", minPrice);
    if (maxPrice) query.set("maxPrice", maxPrice);
    if (availability) query.set("availability", availability);
    if (mode === "new") query.set("newArrival", "true");
    if (mode === "deals") query.set("deals", "true");
    return `/catalog/products?${query.toString()}`;
  }, [availability, brandId, categoryId, direction, maxPrice, minPrice, mode, page, search, sort]);
  useEffect(() => { setError(""); setResult(null); apiRequest<{ data: typeof result }>(endpoint).then((response) => setResult(response.data as NonNullable<typeof result>)).catch((reason) => setError(reason instanceof Error ? reason.message : "Please try again.")); }, [endpoint]);
  function updateFilter(key: string, value: string) { const next = new URLSearchParams(searchParams); if (value) next.set(key, value); else next.delete(key); if (key !== "page") next.delete("page"); setSearchParams(next); }
  async function quickAdd(product: ProductCard) { try { await apiRequest("/cart/items", { method: "POST", body: JSON.stringify({ productId: product.id, quantity: 1 }) }); setQuickFeedback(`${product.name} added to your cart.`); } catch (reason) { setQuickFeedback(reason instanceof Error ? reason.message : "This item could not be added."); } }
  const selectedCategory = category ?? (categoryId ? categories?.find((item) => item.id === categoryId) : undefined);
  const selectedCategoryName = selectedCategory ? publicCategoryName(selectedCategory.name) : null;
  const title = mode === "new" ? "New arrivals" : mode === "deals" ? "Live deals" : search ? `Results for “${search}”` : selectedCategory ? selectedCategoryName ?? "Shop" : brand?.name || "Shop";
  const seoTitle = selectedCategory ? selectedCategoryName ?? "Shop" : brand?.seoTitle || title;
  const publicFilterCategories = publicCategories((categories ?? []).filter((item) => !item.parentId));
  const cleanPath = mode === "new" ? "/new-arrivals" : mode === "deals" ? "/deals" : category ? `/categories/${category.slug}` : brand ? `/brands/${brand.slug}` : "/shop";
  const noIndex = location.pathname === "/search" || Boolean(searchParams.toString());
  useSeoMeta({ title: seoTitle, description: category?.seoDescription || brand?.seoDescription || "Browse live wholesale products, stock availability, and quantity pricing from Lizzor.", canonicalPath: cleanPath, noIndex, jsonLd: category && !noIndex ? { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: window.location.origin }, { "@type": "ListItem", position: 2, name: "Categories", item: `${window.location.origin}/categories` }, ...publicCategories(categoryTrail(category, categories)).map((item, index) => ({ "@type": "ListItem", position: index + 3, name: item.publicName, item: `${window.location.origin}/categories/${item.slug}` }))] } : undefined });
  return <div className="storefront-page catalog-page"><div className="shell"><Breadcrumbs items={[{ label: title }]} />
       <div className="catalog-heading"><div><span className="eyebrow">{mode === "deals" ? "Curated selection" : "Lizzor catalog"}</span><h1>{title}</h1><p>Shop live products with pricing that becomes clearer as your quantity grows.</p></div><div className="catalog-heading__count">{result?.meta.total ?? "—"} products</div></div>
     <div className="catalog-toolbar"><form className="catalog-search" onSubmit={(event) => event.preventDefault()}><Icon name="search" size={17} /><input aria-label="Search products" value={search} onChange={(event) => updateFilter("q", event.target.value)} placeholder="Search name, SKU, brand or category" />{search && <button type="button" aria-label="Clear search" onClick={() => updateFilter("q", "")}><Icon name="x" size={14} /></button>}</form><div className="catalog-toolbar__actions"><button className="catalog-filter-toggle" type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}><Icon name="sliders-horizontal" size={16} /> Filters {activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button><label className="catalog-sort">Sort by<select value={`${sort}:${direction}`} onChange={(event) => { const [nextSort, nextDirection] = event.target.value.split(":"); const next = new URLSearchParams(searchParams); next.set("sort", nextSort); next.set("direction", nextDirection); next.delete("page"); setSearchParams(next); }}><option value="updated:desc">Featured</option><option value="created:desc">Newest</option><option value="price:asc">Price: low to high</option><option value="price:desc">Price: high to low</option><option value="name:asc">Name</option></select></label></div></div>
    {quickFeedback && <div className="commerce-notice commerce-notice--positive"><Icon name="check" size={16} />{quickFeedback}<Link className="text-link" to="/cart">View cart <Icon name="arrow-right" size={14} /></Link></div>}
     {filtersOpen && <button className="catalog-filter-backdrop" type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)} />}
       <div className="catalog-layout"><aside className={`catalog-filters${filtersOpen ? " is-open" : ""}`} aria-label="Catalog filters"><div className="catalog-filter__mobile-top"><strong>Filter products</strong><button className="icon-button" type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)}><Icon name="x" size={18} /></button></div><div className="catalog-filter__heading"><span className="eyebrow">Refine{activeFilterCount > 0 && <b className="catalog-filter__count">{activeFilterCount}</b>}</span><button className="text-button" onClick={() => { const next = new URLSearchParams(searchParams); ["category", "brand", "minPrice", "maxPrice", "availability", "page"].forEach((key) => next.delete(key)); setSearchParams(next); }}>Clear all</button></div><fieldset><legend>Category</legend><button className={!categoryId ? "is-active" : ""} onClick={() => updateFilter("category", "")}>All categories</button>{publicFilterCategories.map((filterCategory) => <button className={categoryId === filterCategory.id ? "is-active" : ""} key={filterCategory.id} onClick={() => updateFilter("category", filterCategory.id)}>{filterCategory.publicName}</button>)}</fieldset><fieldset><legend>Brand</legend>{brands?.length ? brands.slice(0, 8).map((brand) => <button className={brandId === brand.id ? "is-active" : ""} key={brand.id} onClick={() => updateFilter("brand", brand.id)}>{brand.name}</button>) : <p className="filter-muted">No brands available yet.</p>}</fieldset><fieldset><legend>Price</legend><div className="price-filter"><input aria-label="Minimum price" type="number" min="0" placeholder="Min" value={minPrice} onChange={(event) => updateFilter("minPrice", event.target.value)} /><input aria-label="Maximum price" type="number" min="0" placeholder="Max" value={maxPrice} onChange={(event) => updateFilter("maxPrice", event.target.value)} /></div></fieldset><fieldset><legend>Availability</legend><select aria-label="Availability" value={availability} onChange={(event) => updateFilter("availability", event.target.value)}><option value="">All stock</option><option value="in_stock">In stock</option><option value="low_stock">Low stock</option><option value="out_of_stock">Out of stock</option></select></fieldset><div className="catalog-filter__mobile-actions"><button className="button button--quiet" type="button" onClick={() => { const next = new URLSearchParams(searchParams); ["category", "brand", "minPrice", "maxPrice", "availability", "page"].forEach((key) => next.delete(key)); setSearchParams(next); }}>Clear filters</button><button className="button button--dark" type="button" onClick={() => setFiltersOpen(false)}>Apply filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</button></div></aside>
      <section className="catalog-results" aria-live="polite">{error ? <CatalogError message={error} retry={() => window.location.reload()} /> : !result ? <CatalogLoading /> : result.items.length ? <><div className="catalog-grid">{result.items.map((product) => <ProductCardView product={product} onQuickAdd={quickAdd} key={product.id} />)}</div><div className="catalog-pagination"><button className="button button--quiet button--small" disabled={result.meta.page <= 1} onClick={() => updateFilter("page", String(result.meta.page - 1))}><Icon name="arrow-left" size={14} /> Previous</button><span>Page {result.meta.page}</span><button className="button button--quiet button--small" disabled={!result.meta.hasNext} onClick={() => updateFilter("page", String(result.meta.page + 1))}>Next <Icon name="arrow-right" size={14} /></button></div></> : <div className="storefront-state"><Icon name="search" size={26} /><h2>No products matched that search.</h2><p>Try a different name, SKU, brand, or category.</p><button className="button button--dark" onClick={() => setSearchParams({})}>Reset filters</button></div>}</section></div>
  </div></div>;
}

export function CategoryPage() {
  const { slug } = useParams();
  const { categories } = useCatalogData();
  const category = categories?.find((item) => item.slug === slug);
  if (!category) return <CatalogPage />;
  const categoryName = publicCategoryName(category.name);
  if (!categoryName) return <CatalogPage category={category} />;
  const description = publicCategoryDescription(category.description);
    return <div className="category-page-intro"><div className="shell"><Breadcrumbs items={[{ label: "Categories", to: "/categories" }, ...categoryCrumbs(category, categories)]} /><div className="category-hero">{category.imageUrl && <img className={`category-hero__image ${categoryHeroImageClass(category.name)}`} src={category.imageUrl} alt="" loading="eager" decoding="async" />}<div><span className="eyebrow">Category</span><h1>{categoryName}</h1>{description && <p>{description}</p>}</div></div></div><CatalogPage category={category} /></div>;
}

export function CategoriesPage() {
  const { categories } = useCatalogData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useSeoMeta({ title: "Categories", description: "Browse the Lizzor wholesale catalog by category.", canonicalPath: "/categories" });
  const roots = publicCategories((categories ?? []).filter((category) => !category.parentId));
  const selected = roots.find((category) => category.id === selectedId) ?? roots[0];
  useEffect(() => { if (selected && !selectedId) setSelectedId(selected.id); }, [selected, selectedId]);
  if (categories === null) return <div className="storefront-page categories-page"><div className="shell"><Breadcrumbs items={[{ label: "Categories" }]} /><div className="catalog-heading"><div><span className="eyebrow">Browse the catalog</span><h1>Explore categories</h1><p>Find everything your business needs in one place.</p></div></div><CatalogLoading /></div></div>;
  return <div className="storefront-page categories-page"><div className="shell"><Breadcrumbs items={[{ label: "Categories" }]} /><div className="catalog-heading categories-page__heading"><div><span className="eyebrow">Browse the catalog</span><h1>Explore categories</h1><p>Find everything your business needs in one place.</p></div></div>{!roots.length ? <div className="storefront-state storefront-state--empty"><Icon name="layers-3" size={25} /><h2>No categories available</h2><p>Published categories will appear here when they are ready to browse.</p></div> : <><div className="category-hub"><nav className="category-hub__nav" aria-label="Category navigation">{roots.map((category) => <button type="button" key={category.id} className={selected?.id === category.id ? "is-active" : ""} aria-current={selected?.id === category.id ? "page" : undefined} onClick={() => setSelectedId(category.id)}><span className="category-hub__thumb">{category.imageUrl ? <img src={category.imageUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="layers-3" size={19} />}</span><strong>{category.publicName}</strong><Icon name="arrow-right" size={16} /></button>)}</nav>{selected && <CategoryHubContent category={selected} categories={categories} />}</div><div className="category-accordion" aria-label="Categories">{roots.map((category) => { const children = publicCategoryChildren(categories, category.id); const expanded = openId === category.id; return <section className={`category-accordion__section${expanded ? " is-open" : ""}`} key={category.id}><button type="button" className="category-accordion__trigger" aria-expanded={expanded} aria-controls={`category-panel-${category.id}`} onClick={() => setOpenId(expanded ? null : category.id)}><span className="category-accordion__thumb">{category.imageUrl ? <img src={category.imageUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="layers-3" size={20} />}</span><span className="category-accordion__copy"><strong>{category.publicName}</strong><small>{children.slice(0, 4).map((child) => child.publicName).join(" · ") || "Explore this collection"}</small></span><Icon name="chevron-down" size={18} /></button><div className="category-accordion__panel" id={`category-panel-${category.id}`} hidden={!expanded}><div className="category-accordion__links">{children.map((child) => <Link to={`/categories/${child.slug}`} key={child.id}>{child.publicName}<Icon name="arrow-right" size={14} /></Link>)}</div><Link className="category-accordion__all" to={`/categories/${category.slug}`}>View all {category.publicName}<Icon name="arrow-right" size={15} /></Link></div></section>; })}</div></>}</div></div>;
}

function CategoryHubContent({ category, categories }: { category: Category & { publicName: string }; categories: Category[] }) {
  const children = publicCategoryChildren(categories, category.id);
  const description = publicCategoryDescription(category.description);
  const otherRoots = publicCategories(categories.filter((item) => !item.parentId && item.id !== category.id)).slice(0, 8);
  return <section className="category-hub__content" aria-live="polite"><div className="category-hub__banner">{category.imageUrl ? <img src={category.imageUrl} alt="" loading="eager" decoding="async" /> : <div className="category-hub__banner-fallback"><Icon name="layers-3" size={48} /></div>}<div className="category-hub__banner-copy"><span className="category-hub__pill">{category.publicName}</span><h2>{category.publicName}</h2><p>{description || "Quality products selected to help you stock what your customers need."}</p><Link className="button button--dark" to={`/categories/${category.slug}`}>Shop all {category.publicName}<Icon name="arrow-right" size={15} /></Link></div></div><div className="category-hub__section-heading"><h3>Shop subcategories</h3></div>{children.length ? <div className="category-hub__tiles">{children.map((child) => <Link to={`/categories/${child.slug}`} key={child.id}>{child.imageUrl ? <img src={child.imageUrl} alt="" loading="lazy" decoding="async" /> : <span className="category-hub__tile-icon"><Icon name="layers-3" size={18} /></span>}<strong>{child.publicName}</strong><Icon name="arrow-right" size={14} /></Link>)}</div> : <p className="category-hub__empty">Browse the full {category.publicName} collection to see available products.</p>}<div className="category-hub__popular"><div className="category-hub__section-heading"><h3>Other popular categories</h3><Link to="/categories">View all <Icon name="arrow-right" size={13} /></Link></div><div>{otherRoots.map((item) => <Link to={`/categories/${item.slug}`} key={item.id}><span>{item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : <Icon name="layers-3" size={17} />}</span><small>{item.publicName}</small></Link>)}</div></div></section>;
}

export function BrandsDirectoryPage() {
  const { brands } = useCatalogData();
  useSeoMeta({ title: "Brands", description: "Discover the brands in the Lizzor wholesale catalog.", canonicalPath: "/brands" });
  return <div className="storefront-page brands-page"><div className="shell"><Breadcrumbs items={[{ label: "Brands" }]} /><div className="catalog-heading"><div><span className="eyebrow">Browse the catalog</span><h1>Brands</h1><p>Explore the makers behind the range.</p></div></div>{brands === null ? <CatalogLoading /> : brands.length ? <div className="brand-directory">{brands.map((brand) => <Link className="brand-directory__item" to={`/brands/${brand.slug}`} key={brand.id}>{brand.logoUrl ? <img src={brand.logoUrl} alt="" /> : <span className="brand-directory__mark">{brand.name.slice(0, 1)}</span>}<span><strong>{brand.name}</strong>{brand.description && <small>{brand.description}</small>}</span><Icon name="arrow-up-right" size={17} /></Link>)}</div> : <div className="storefront-state"><Icon name="badge" size={24} /><h2>No brands are published yet.</h2><p>Published brands will appear here as the catalog grows.</p></div>}</div></div>;
}

export function BrandPage() {
  const { slug } = useParams();
  const { brands } = useCatalogData();
  const brand = brands?.find((item) => item.slug === slug);
   return <div className="brand-page"><div className="shell"><Breadcrumbs items={[{ label: "Brands", to: "/brands" }, { label: brand?.name ?? "Brand" }]} /><div className="brand-hero">{brand?.logoUrl ? <img src={brand.logoUrl} alt={brand.name} decoding="async" /> : <div className="brand-hero__mark">{brand?.name?.slice(0, 1) ?? "L"}</div>}<div><span className="eyebrow">Manufacturer</span><h1>{brand?.name ?? "Brand"}</h1>{brand?.description && <p>{brand.description}</p>}</div></div></div><CatalogPage brand={brand} /></div>;
}

export function WishlistPage() {
  const { user, loading: authLoading } = useAuth();
  const { version } = useWishlist();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ items: ProductCard[]; meta: { page: number; total: number; hasNext: boolean } } | null>(null);
  const [error, setError] = useState("");
  useSeoMeta({ title: "Wishlist", description: "Your saved Lizzor wholesale products.", canonicalPath: "/wishlist", noIndex: true });
  useEffect(() => {
    if (!user) return;
    apiRequest<{ data: { items: ProductCard[]; meta: { page: number; total: number; hasNext: boolean } } }>(`/wishlist?page=${page}&pageSize=24`).then((response) => {
      const lastPage = Math.max(1, Math.ceil(response.data.meta.total / 24));
      if (page > lastPage) setPage(lastPage);
      else setResult(response.data);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Wishlist could not be loaded."));
  }, [user, version, page]);
  async function quickAdd(product: ProductCard) {
    try {
      await apiRequest("/cart/items", { method: "POST", body: JSON.stringify({ productId: product.id, quantity: 1 }) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This item could not be added.");
    }
  }
  if (authLoading) return <div className="storefront-page"><div className="shell"><CatalogLoading /></div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <div className="storefront-page wishlist-page"><div className="shell"><Breadcrumbs items={[{ label: "Wishlist" }]} /><div className="catalog-heading"><div><span className="eyebrow">Saved for later</span><h1>Your wishlist</h1><p>Keep useful products close while you build your next order.</p></div><div className="catalog-heading__count">{result?.meta.total ?? "—"} saved</div></div>{error ? <CatalogError message={error} retry={() => window.location.reload()} /> : result === null ? <CatalogLoading /> : result.items.length ? <><div className="catalog-grid">{result.items.map((product) => <ProductCardView product={product} onQuickAdd={quickAdd} key={product.id} />)}</div><div className="catalog-pagination"><button className="button button--quiet button--small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><Icon name="arrow-left" size={14} /> Previous</button><span>Page {result.meta.page}</span><button className="button button--quiet button--small" disabled={!result.meta.hasNext} onClick={() => setPage((current) => current + 1)}>Next <Icon name="arrow-right" size={14} /></button></div></> : <div className="storefront-state"><Icon name="heart" size={28} /><h2>Your wishlist is ready for your next idea.</h2><p>Save products as you browse and they’ll appear here.</p><Link className="button button--dark" to="/shop">Browse the catalog <Icon name="arrow-right" size={15} /></Link></div>}</div></div>;
}

export function ProductPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState<Product | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<{ quantity: number; productName: string; variantTitle?: string } | null>(null);
  const [quote, setQuote] = useState<{ unitPrice: number; totalPrice: number; promotionDiscount?: number; promotionName?: string | null; finalUnitPrice?: number; finalTotalPrice?: number } | null>(null);
  const { categories } = useCatalogData();
  const productCategory = product ? categories?.find((item) => item.id === product.category.id) ?? { ...product.category, parentId: null } : null;
  const productCategoryTrail = productCategory ? publicCategories(categoryTrail(productCategory, categories)) : [];
  const productPublicName = product ? publicProductName(product.name) : "Product";
  useSeoMeta({ title: product?.seoTitle || productPublicName, description: product?.seoDescription || product?.shortDescription || "View product availability and wholesale quantity pricing.", canonicalPath: `/products/${slug ?? ""}`, type: "product", image: product?.media.find((item) => item.type === "image")?.url, jsonLd: product ? { "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: productPublicName, description: product.seoDescription || product.shortDescription || product.description, image: product.media.filter((item) => item.type === "image").map((item) => item.url), offers: { "@type": "Offer", priceCurrency: "EUR", price: product.promotionalPrice ?? product.price, availability: product.availability === "out_of_stock" ? "https://schema.org/OutOfStock" : "https://schema.org/InStock", url: `${window.location.origin}/products/${product.slug}` } }, { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: window.location.origin }, ...productCategoryTrail.map((item, index) => ({ "@type": "ListItem", position: index + 2, name: item.publicName, item: `${window.location.origin}/categories/${item.slug}` })), { "@type": "ListItem", position: productCategoryTrail.length + 2, name: productPublicName, item: `${window.location.origin}/products/${product.slug}` }] }] } : undefined });
  useEffect(() => { if (!slug) return; setProduct(null); apiRequest<{ data: Product }>(`/catalog/products/${encodeURIComponent(slug)}`).then(unwrap).then((next) => { setProduct(next); setSelectedVariantId(next.variants[0]?.id ?? ""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "This product could not be loaded.")); }, [slug]);
  const variant = product?.variants.find((item) => item.id === selectedVariantId);
  const activePrice = variant?.price ?? product?.price ?? 0;
  const activeTiers = variant ? variant.tiers : product?.tiers ?? [];
  const activeUnitPrice = quote?.finalUnitPrice ?? variant?.promotionalPrice ?? product?.promotionalPrice ?? quote?.unitPrice ?? activePrice;
  const activeStock = variant?.available ?? product?.available ?? 0;
   const activeMedia = variant?.media?.length ? [...variant.media, ...(product?.media.filter((item) => !item.variantId) ?? [])] : product?.media ?? [];
  useEffect(() => { setQuantity((current) => Math.max(1, Math.min(current, Math.max(1, activeStock)))); setMediaIndex(0); }, [activeStock, selectedVariantId]);
  useEffect(() => { if (!product) return; const query = new URLSearchParams({ quantity: String(quantity) }); if (variant) query.set("variantId", variant.id); apiRequest<{ data: NonNullable<typeof quote> }>(`/catalog/products/${product.slug}/quote?${query}`).then(unwrap).then(setQuote).catch(() => setQuote(null)); }, [product, quantity, variant]);
  async function addToCart() { if (!product || activeStock < 1) return; if (quantity > activeStock) { setError(`Only ${activeStock} units are currently available.`); return; } try { await apiRequest("/cart/items", { method: "POST", body: JSON.stringify({ productId: product.id, variantId: variant?.id, quantity }) }); setFeedback({ quantity, productName: publicProductName(product.name), variantTitle: variant?.title?.trim() || undefined }); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "This item could not be added."); } }
  if (error && !product) return <div className="storefront-page"><div className="shell"><CatalogError message={error} retry={() => window.location.reload()} /></div></div>;
  if (!product) return <div className="storefront-page"><div className="shell"><CatalogLoading /></div></div>;
  const currentMedia = activeMedia[mediaIndex] ?? activeMedia[0];
  return <div className="storefront-page product-page"><div className="shell"><Breadcrumbs items={[...productCategoryTrail.map((item) => ({ label: item.publicName, to: `/categories/${item.slug}` })), { label: productPublicName }]} />
    <div className="product-layout"><section className="product-gallery"><div className="product-gallery__main">{currentMedia?.url ? currentMedia.type === "video" ? <video controls src={currentMedia.url} aria-label={currentMedia.altText ?? productPublicName} /> : <img src={currentMedia.url} alt={currentMedia.altText ?? productPublicName} /> : <ProductImage product={product} large />}</div>{activeMedia.length > 1 && <div className="product-gallery__thumbs">{activeMedia.map((media, index) => <button className={index === mediaIndex ? "is-active" : ""} onClick={() => setMediaIndex(index)} key={media.id} aria-label={`View image ${index + 1}`}><img src={media.url} alt="" /></button>)}</div>}</section>
      <section className="product-information"><div className="product-information__meta"><span className="eyebrow">{product.brand ? publicBrandName(product.brand.name) : "Lizzor catalog"}</span><WishlistButton productId={product.id} initialSaved={product.wishlisted} /></div><h1>{productPublicName}</h1>{product.shortDescription && <p className="product-lede">{product.shortDescription}</p>}<div className="product-price"><strong>{money(activeUnitPrice)}</strong>{quote?.promotionDiscount ? <del>{money(quote.unitPrice)}</del> : null}<span>per unit · VAT included where applicable</span></div>{quote?.promotionDiscount ? <p className="product-saving">Wholesale tier: {money(quote.unitPrice)} · {quote.promotionName}: −{money(quote.promotionDiscount)} · Your price: {money(activeUnitPrice)}</p> : activeUnitPrice < activePrice && <p className="product-saving">You save {money((activePrice - activeUnitPrice) * quantity)} at this quantity.</p>}<Availability value={variant?.availability ?? product.availability} available={activeStock} />
         {product.variants.length > 0 && <div className="variant-selector"><span className="field-label">Options</span><div role="group" aria-label="Product options">{product.variants.map((item) => <button type="button" aria-pressed={item.id === selectedVariantId} className={item.id === selectedVariantId ? "is-active" : ""} disabled={item.availability === "out_of_stock"} onClick={() => setSelectedVariantId(item.id)} key={item.id}>{item.title}<small>{item.availability === "out_of_stock" ? "Out of stock" : money(item.price)}</small></button>)}</div></div>}
        {activeTiers.length > 0 && <div className="tier-panel"><div className="tier-panel__heading"><div><span className="eyebrow">Quantity pricing</span><h2>Buy more, pay less.</h2></div><span>No minimum order</span></div><div className="tier-table" role="group" aria-label="Quantity pricing shortcuts">{activeTiers.map((tier) => { const tierQuantity = quantityForTier(tier, activeStock); const active = isQuantityInTier(quantity, tier); return <button type="button" className={`${active ? "is-active" : ""}${tierQuantity === null ? " is-unavailable" : ""}`} aria-pressed={active} disabled={tierQuantity === null} title={tierQuantity === null ? `Requires at least ${tier.minQuantity} units; only ${activeStock} available` : `Set quantity to ${tier.minQuantity}`} onClick={() => tierQuantity !== null && setQuantity(tierQuantity)} key={tier.id}><span>{tier.minQuantity}–{tier.maxQuantity ?? "∞"} units</span><strong>{money(tier.unitPrice)}</strong><small>{tierQuantity === null ? "Unavailable" : "each"}</small></button>; })}</div></div>}
        <div className="purchase-panel"><div className="quantity-control"><span className="field-label">Quantity</span><div><button aria-label="Decrease quantity" disabled={quantity <= 1} onClick={() => setQuantity((current) => current - 1)}>−</button><output aria-label="Selected quantity">{quantity}</output><button aria-label="Increase quantity" disabled={quantity >= activeStock} onClick={() => setQuantity((current) => current + 1)}>+</button></div></div><div className="purchase-total"><span>Line total</span><strong>{money(quote?.finalTotalPrice ?? quote?.totalPrice ?? activeUnitPrice * quantity)}</strong></div><button className="button button--dark purchase-button" disabled={activeStock < 1} onClick={() => void addToCart()}>{activeStock < 1 ? "Out of stock" : "Add to cart"} <Icon name="arrow-right" size={16} /></button></div>
        {feedback && <div className="cart-add-success" role="status" aria-live="polite"><span className="cart-add-success__icon" aria-hidden="true"><Icon name="check" size={14} /></span><div className="cart-add-success__copy"><strong>Added to cart</strong><span>{feedback.quantity} × {feedback.productName}{feedback.variantTitle ? ` · ${feedback.variantTitle}` : ""}</span></div><Link className="cart-add-success__link" to="/cart">View cart <Icon name="arrow-right" size={13} /></Link></div>}{error && <div className="commerce-notice commerce-notice--warning"><Icon name="circle-help" size={16} />{error}</div>}
        <div className="product-details"><div><span className="eyebrow">About this product</span><p>{product.description}</p></div><dl><div><dt>Availability</dt><dd>{activeStock > 0 ? "Ready to order" : "Currently unavailable"}</dd></div><div><dt>Delivery</dt><dd>Shipping calculated at checkout</dd></div><div><dt>Returns</dt><dd>Eligible items can be requested from your order</dd></div></dl></div>
      </section></div><div className="product-mobile-sticky"><span>{money(quote?.finalTotalPrice ?? quote?.totalPrice ?? activeUnitPrice * quantity)}</span><button className="button button--dark" disabled={activeStock < 1} onClick={() => void addToCart()}>Add to cart</button></div>
    </div></div>;
}