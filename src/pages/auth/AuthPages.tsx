import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, apiRequest } from "../../auth/api";
import { useAuth, type AuthUser } from "../../auth/AuthContext";
import { EUROPEAN_COUNTRIES, getEuropeanCountry } from "../../../shared/europeanCountries";
import { LegalNavigation } from "../../components/legal/LegalNavigation";
import { LegalAcceptance } from "../../components/legal/LegalAcceptance";

function AuthCard({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="auth-page shell"><div className="auth-card"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{children}<LegalNavigation location="authentication" /></div></section>;
}

function ErrorMessage({ message }: { message: string }) {
  return message ? <p className="form-message form-message--error" role="alert">{message}</p> : null;
}

function localPhoneError(value: FormDataEntryValue | null, label: string): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return `${label} is required.`;
  if (raw.includes("+")) return `Enter ${label.toLowerCase()} without the country prefix.`;
  if (!/^[\d\s().-]+$/.test(raw)) return `${label} contains invalid characters.`;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 14) return `${label} must contain a valid phone number.`;
  return null;
}

export function LoginPage({ admin = false }: { admin?: boolean }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const returnToValue = params.get("returnTo");
  const returnTo = !admin && Boolean(returnToValue?.startsWith("/") && !returnToValue.startsWith("//")) ? returnToValue! : "/account";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest(`/auth/${admin ? "admin/login" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      await refresh();
      navigate(admin ? "/admin" : returnTo);
    } catch (caught) {
      if (admin && caught instanceof ApiError && caught.code === "TWO_FACTOR_CHALLENGE_REQUIRED") {
        const token = (caught.details as { challengeToken?: unknown } | undefined)?.challengeToken;
        if (typeof token === "string" && token.length >= 32) {
          setChallengeToken(token);
          setError("");
          return;
        }
      }
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    }
  }
  async function verifyTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!challengeToken) return;
    const code = new FormData(event.currentTarget).get("code");
    try {
      await apiRequest("/auth/admin/login/verify-2fa", { method: "POST", body: JSON.stringify({ challengeToken, code }) });
      await refresh();
      navigate("/admin");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Two-factor verification failed.");
    }
  }
  return <AuthCard eyebrow={admin ? "Administration" : "Welcome back"} title={admin ? "Admin sign in" : "Sign in"}>
    {challengeToken ? <form className="auth-form" onSubmit={verifyTwoFactor}>
      <p className="auth-summary">Enter the six-digit code from your authenticator, or an unused recovery code.</p>
      <label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={128} required autoFocus /></label>
      <ErrorMessage message={error} />
      <button className="button button--primary" type="submit">Verify and sign in</button>
    </form> : <form className="auth-form" onSubmit={submit}>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <ErrorMessage message={error} />
      <button className="button button--primary" type="submit">Sign in</button>
    </form>}
    {!admin && <div className="auth-links"><Link to="/forgot-password">Forgot password?</Link><Link to="/register">Create an account</Link></div>}
  </AuthCard>;
}

export function RegisterPage({ businessDefault = false }: { businessDefault?: boolean }) {
  const [business, setBusiness] = useState(businessDefault);
  const [countryCode, setCountryCode] = useState("CY");
  const [phone, setPhone] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [error, setError] = useState("");
  const [legalAcceptance, setLegalAcceptance] = useState<string[]>([]);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnToValue = params.get("returnTo");
  const returnTo = returnToValue?.startsWith("/") && !returnToValue.startsWith("//") ? returnToValue : "/account";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const validationError = localPhoneError(values.phone, "Phone")
      ?? (business ? localPhoneError(values.companyPhone, "Company phone") : null);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      await apiRequest(`/auth/register${business ? "/business" : ""}`, { method: "POST", body: JSON.stringify({ ...values, legalAcceptance }) });
      await refresh();
      navigate(returnTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Registration failed.");
    }
  }
  const selectedCountry = getEuropeanCountry(countryCode) ?? EUROPEAN_COUNTRIES[0];
  function countryOptions() {
    return EUROPEAN_COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.flag} {country.name}</option>);
  }
  function phoneField(label: string, name: "phone" | "companyPhone", value: string, setValue: (next: string) => void, autoComplete: string) {
    return <label className="auth-phone-field"><span>{label}</span><div className="auth-phone-control">
      <span className="auth-phone-prefix" aria-hidden="true"><span className="auth-phone-flag">{selectedCountry.flag}</span><b>+{selectedCountry.dialingCode}</b></span>
      <input name={name} value={value} onChange={(event) => setValue(event.target.value)} inputMode="tel" autoComplete={autoComplete} placeholder="99 123456" title={`Enter ${label.toLowerCase()} without the country prefix.`} required />
    </div></label>;
  }
  return <AuthCard eyebrow="Customer accounts" title="Create your Lizzor account">
    <div className="account-choice">
      <button type="button" className={!business ? "is-active" : ""} onClick={() => setBusiness(false)}>Personal account</button>
      <button type="button" className={business ? "is-active" : ""} onClick={() => setBusiness(true)}>Business account</button>
    </div>
    <form className="auth-form auth-form--grid" onSubmit={submit}>
      <label>First name<input name="firstName" autoComplete="given-name" required /></label>
      <label>Last name<input name="lastName" autoComplete="family-name" required /></label>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Country<select className="auth-country-select" name="countryCode" value={countryCode} onChange={(event) => setCountryCode(event.target.value)} required>{countryOptions()}</select></label>
      {phoneField("Phone", "phone", phone, setPhone, "tel")}
      {business && <>
        <label>Company name<input name="companyName" required /></label>
        <label>VAT number <small>Optional</small><input name="vatNumber" /></label>
        <label>Registration number <small>Optional</small><input name="registrationNumber" /></label>
        <label>Contact person<input name="contactPerson" required /></label>
        <label>Company email<input name="companyEmail" type="email" required /></label>
        {phoneField("Company phone", "companyPhone", companyPhone, setCompanyPhone, "tel")}
      </>}
      <label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
      <label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
       <LegalAcceptance scope="account" value={legalAcceptance} onChange={setLegalAcceptance} />
      <ErrorMessage message={error} />
      <button className="button button--primary auth-form__submit" type="submit">Create {business ? "business" : "personal"} account</button>
    </form>
    <div className="auth-links"><span>Already registered?</span><Link to="/login">Sign in</Link></div>
  </AuthCard>;
}

export function ForgotPasswordPage() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const email = new FormData(event.currentTarget).get("email");
    try {
      const response = await apiRequest<{ data: { message: string } }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      setMessage(response.data.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reset instructions could not be requested.");
    }
  }
  return <AuthCard eyebrow="Account recovery" title="Reset your password"><form className="auth-form" onSubmit={submit}>
    <label>Email<input name="email" type="email" required /></label><button className="button button--primary">Send reset instructions</button>
    <ErrorMessage message={error} />
    {message && <p className="form-message">{message}</p>}
  </form></AuthCard>;
}

export function TokenPage({ mode }: { mode: "verify" | "reset" }) {
  const [params] = useSearchParams();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      if (mode === "verify") {
        await apiRequest("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: params.get("token") }) });
      } else {
        await apiRequest("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: params.get("token"), password: data.get("password"), confirmPassword: data.get("confirmPassword") }) });
      }
      setMessage(mode === "verify" ? "Your email is verified." : "Your password has been reset.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The link could not be used.");
    }
  }
  return <AuthCard eyebrow="Account security" title={mode === "verify" ? "Verify your email" : "Choose a new password"}>
    <form className="auth-form" onSubmit={submit}>
      {mode === "reset" && <><label>New password<input name="password" type="password" minLength={12} required /></label><label>Confirm password<input name="confirmPassword" type="password" minLength={12} required /></label></>}
      <ErrorMessage message={error} />{message && <p className="form-message">{message}</p>}
      {mode === "verify" && message
        ? <Link className="button button--primary" to="/account">Continue to your account</Link>
        : <button className="button button--primary">{mode === "verify" ? "Verify email" : "Reset password"}</button>}
    </form>
  </AuthCard>;
}

export function AccountPage() {
  const { user, loading, refresh, logout } = useAuth();
  const [error, setError] = useState("");
  if (loading) return <AuthCard eyebrow="Customer area" title="Loading…"><p>Checking your session.</p></AuthCard>;
  if (!user) return <Navigate to="/login" replace />;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest("/account/profile", { method: "PATCH", body: JSON.stringify({ firstName: data.get("firstName"), lastName: data.get("lastName"), phone: data.get("phone") || null }) });
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Profile update failed."); }
  }
  return <AuthCard eyebrow={`${user.accountType} account`} title={`Hello, ${user.firstName}`}>
    <p className="auth-summary">{user.email} · {user.emailVerifiedAt ? "Verified email" : "Email verification pending"}</p>
    {user.company && <div className="company-summary"><strong>{user.company.name}</strong><span>{user.company.vatNumber ? `VAT ${user.company.vatNumber}` : "VAT not provided"} · {user.company.countryCode}</span></div>}
    <form className="auth-form auth-form--grid" onSubmit={submit}>
      <label>First name<input name="firstName" defaultValue={user.firstName} required /></label>
      <label>Last name<input name="lastName" defaultValue={user.lastName} required /></label>
      <label>Phone<input name="phone" defaultValue={user.phone ?? ""} /></label>
      <ErrorMessage message={error} />
      <button className="button button--primary auth-form__submit">Save profile</button>
    </form>
    <div className="auth-links"><Link to="/account/orders">View order history</Link><Link to="/wishlist">Open wishlist</Link><Link to="/shop">Continue shopping</Link></div>
    <button className="button button--quiet" onClick={() => logout()}>Sign out</button>
  </AuthCard>;
}

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { loading, sessionType } = useAuth();
  if (loading) return <div className="auth-page"><p>Checking administrator access…</p></div>;
  return sessionType === "admin" ? children : <Navigate to="/admin/login" replace />;
}