import { Link } from "react-router-dom";
import type { PlaceholderPage } from "../../../shared/types";
import { Icon } from "../../components/ui/Icon";

interface StorefrontPageProps {
  page: PlaceholderPage;
  isHome: boolean;
}

export function StorefrontPage({ page, isHome }: StorefrontPageProps) {
  return (
    <div className={`storefront-page ${isHome ? "storefront-page--home" : ""}`}>
      <div className="shell">
        <div className="breadcrumb">
          <Link to="/">Home</Link>
          {!isHome && <><Icon name="arrow-right" size={13} /><span>{page.title}</span></>}
        </div>
        <section className="storefront-hero">
          <div className="storefront-hero__copy">
            <span className="eyebrow">{page.eyebrow}</span>
            <h1>{page.title}</h1>
            <p>{page.description}</p>
            {isHome && (
              <div className="hero-actions">
                <Link className="button button--dark" to="/shop">Explore the shell <Icon name="arrow-right" size={16} /></Link>
                <Link className="text-link" to="/start-a-business">For business <Icon name="arrow-up-right" size={15} /></Link>
              </div>
            )}
          </div>
          <div className="hero-art" aria-label="Lizzor storefront illustration">
            <div className="hero-art__ring hero-art__ring--one" />
            <div className="hero-art__ring hero-art__ring--two" />
            <div className="hero-art__monogram">L</div>
            <div className="hero-art__caption">EST.<br /><b>2026</b></div>
          </div>
        </section>
        <section className="foundation-card">
          <div className="foundation-card__mark"><Icon name="sparkles" size={20} /></div>
          <div>
            <span className="eyebrow">Foundation stage</span>
            <h2>The catalog connection comes next.</h2>
            <p>This route is ready for database-backed content. No sample products or placeholder inventory are shown here.</p>
          </div>
          <div className="foundation-card__arrow"><Icon name="arrow-up-right" size={20} /></div>
        </section>
        {isHome && (
          <section className="home-links">
            <div className="section-heading">
              <div><span className="eyebrow">Built in layers</span><h2>A clear path forward.</h2></div>
              <span className="section-note">The foundation keeps each next system focused.</span>
            </div>
            <div className="home-link-grid">
              {[
                ["Catalog", "/shop", "Products, collections and categories"],
                ["Business accounts", "/start-a-business", "Tools for wholesale customers"],
                ["Support", "/support", "A helpful place to start"],
              ].map(([label, path, description]) => (
                <Link className="home-link-card" to={path} key={path}>
                  <span>{label}</span><p>{description}</p><Icon name="arrow-up-right" size={17} />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}