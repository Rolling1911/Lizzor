import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";

type WishlistMutationResponse = { data: { productId: string; saved: boolean } };

interface WishlistContextValue {
  version: number;
  toggle: (productId: string, initialSaved: boolean) => Promise<void>;
  isSaved: (productId: string, initialSaved: boolean) => boolean;
}

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setOverrides(new Map());
    setVersion(0);
  }, [user?.id]);

  async function toggle(productId: string, initialSaved: boolean) {
    if (!user) {
      navigate("/login");
      return;
    }
    const saved = overrides.get(productId) ?? initialSaved;
    const response = await apiRequest<WishlistMutationResponse>(saved ? `/wishlist/items/${productId}` : "/wishlist/items", {
      method: saved ? "DELETE" : "POST",
      body: saved ? undefined : JSON.stringify({ productId }),
    });
    setOverrides((current) => new Map(current).set(response.data.productId, response.data.saved));
    setVersion((current) => current + 1);
  }

  const value = useMemo(() => ({
    version,
    toggle,
    isSaved: (productId: string, initialSaved: boolean) => overrides.get(productId) ?? initialSaved,
  }), [overrides, version]);
  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const value = useContext(WishlistContext);
  if (!value) throw new Error("useWishlist must be used inside WishlistProvider.");
  return value;
}