import { createContext, useContext, useEffect, useState } from "react";
import { apiRequest } from "./api";
import { clearCheckoutStorageOnLogout } from "../lib/browserStorage";

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  countryCode: string | null;
  accountType: "personal" | "business";
  status: string;
  emailVerifiedAt: string | null;
  company: { id: string; name: string; vatNumber: string | null; countryCode: string | null } | null;
}

interface AuthState {
  user: AuthUser | null;
  sessionType: "customer" | "admin" | null;
  permissions: string[];
  isSuperAdmin: boolean;
}

interface AuthContextValue extends AuthState {
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, sessionType: null, permissions: [], isSuperAdmin: false });
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const response = await apiRequest<{ data: AuthState }>("/auth/me");
    setState(response.data);
    setLoading(false);
  }

  async function logout() {
    await apiRequest("/auth/logout", { method: "POST" });
    clearCheckoutStorageOnLogout();
    setState({ user: null, sessionType: null, permissions: [], isSuperAdmin: false });
  }

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, []);

  return <AuthContext.Provider value={{ ...state, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}