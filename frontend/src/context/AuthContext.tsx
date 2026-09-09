import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import { api, ApiError, AuthConfig, tokens, User, Role, Store } from "@/lib/api";

const STORE_KEY = "rm.active_store";

interface SignInResult { user: User; profileCreated: boolean }

interface AuthValue {
  user: User | null;
  loading: boolean;
  config: AuthConfig | null;
  activeStore: Store | null;
  setActiveStore: (store: Store | null) => void;
  signIn: (email: string, password: string, opts?: {
    remember?: boolean; captchaToken?: string | null;
  }) => Promise<SignInResult>;
  adoptSession: (accessToken: string, refreshToken?: string) => Promise<SignInResult>;
  signOut: () => void;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

export type Permission =
  | "manage_users" | "manage_stores" | "manage_settings" | "view_audit"
  | "manage_products" | "import_data" | "manage_suppliers"
  | "approve_orders" | "update_inventory" | "create_requests"
  /** Browse the ordering catalogue and raise a store order. */
  | "order_products"
  /** See the warehouse board and move orders through pick / pack / ship. */
  | "fulfil_orders";

/**
 * What each role may do.
 *
 * This mirrors the backend guards in `app/core/security.py` — it is a UI
 * convenience, not the control. Every one of these actions is checked again
 * server-side and by row-level security, so hiding a button here is never the
 * only thing stopping an action.
 */
const MATRIX: Record<Role, Permission[]> = {
  super_admin: ["manage_users", "manage_stores", "manage_settings", "view_audit",
    "manage_products", "import_data", "manage_suppliers", "approve_orders",
    "update_inventory", "create_requests", "order_products", "fulfil_orders"],
  admin: ["manage_products", "import_data", "manage_suppliers", "approve_orders",
    "update_inventory", "create_requests", "order_products", "fulfil_orders"],
  inventory_manager: ["approve_orders", "update_inventory", "create_requests",
    "manage_suppliers", "order_products", "fulfil_orders"],
  store_manager: ["create_requests", "order_products"],
  // The warehouse team receives and ships orders. It deliberately has no
  // catalogue, inventory, settings or user permissions.
  warehouse: ["fulfil_orders"],
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [activeStore, setActiveStoreState] = useState<Store | null>(null);

  const applyUser = useCallback((next: User) => {
    setUser(next);
    const savedId = localStorage.getItem(STORE_KEY);
    const saved = next.stores.find((s) => s.id === savedId);
    setActiveStoreState(saved ?? next.stores[0] ?? null);
  }, []);

  const refresh = useCallback(async () => {
    if (!tokens.get()) { setLoading(false); return; }
    try {
      applyUser(await api.get<User>("/auth/me"));
    } catch (error) {
      // Only drop the session for an auth failure. A network blip shouldn't
      // silently sign someone out.
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        tokens.clear();
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [applyUser]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Public auth capabilities, so the UI shows only what is actually wired up.
  useEffect(() => {
    api.get<AuthConfig>("/auth/config").then(setConfig).catch(() => setConfig(null));
  }, []);

  const setActiveStore = useCallback((store: Store | null) => {
    setActiveStoreState(store);
    if (store) localStorage.setItem(STORE_KEY, store.id);
    else localStorage.removeItem(STORE_KEY);
  }, []);

  const signIn = useCallback(async (
    email: string, password: string,
    opts?: { remember?: boolean; captchaToken?: string | null },
  ) => {
    const result = await api.post<{
      access_token: string; refresh_token: string;
      user: User; profile_created: boolean;
    }>("/auth/sign-in", {
      email, password, captcha_token: opts?.captchaToken ?? null,
    });

    tokens.set(result.access_token, result.refresh_token, opts?.remember ?? true);
    applyUser(result.user);
    setLoading(false);
    return { user: result.user, profileCreated: result.profile_created };
  }, [applyUser]);

  /** Completes Google OAuth: hands the Supabase session to the backend, which
   *  resolves profile, role and stores through the same path as password login. */
  const adoptSession = useCallback(async (accessToken: string, refreshToken?: string) => {
    tokens.set(accessToken, refreshToken, true);
    const result = await api.post<{ user: User; profile_created: boolean }>(
      "/auth/session", { access_token: accessToken, refresh_token: refreshToken ?? null },
    );
    applyUser(result.user);
    setLoading(false);
    return { user: result.user, profileCreated: result.profile_created };
  }, [applyUser]);

  const signOut = useCallback(() => {
    tokens.clear();
    localStorage.removeItem(STORE_KEY);
    setUser(null);
    setActiveStoreState(null);
  }, []);

  const can = useCallback(
    // A role the frontend doesn't recognise (an older build against a newer
    // database) gets no permissions rather than a crash.
    (permission: Permission) =>
      !!user && (MATRIX[user.role] ?? []).includes(permission),
    [user],
  );

  const value = useMemo(() => ({
    user, loading, config, activeStore, setActiveStore,
    signIn, adoptSession, signOut, refresh, can,
  }), [user, loading, config, activeStore, setActiveStore,
       signIn, adoptSession, signOut, refresh, can]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  inventory_manager: "Inventory manager",
  store_manager: "Store manager",
  warehouse: "Warehouse team",
};
