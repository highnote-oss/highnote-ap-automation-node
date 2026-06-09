import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api, type AuthResponse, type AuthUser } from "../api/client";

interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function parseStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem("auth_user");
    if (raw) return JSON.parse(raw) as AuthUser;
  } catch {
    // ignore
  }
  return null;
}

function persistAuthResponse(response: AuthResponse): {
  token: string;
  user: AuthUser;
} {
  const { token, user } = response;
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
  return { token, user };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem("auth_token")
  );
  const [user, setUserState] = useState<AuthUser | null>(() =>
    parseStoredUser()
  );

  const isAuthenticated = !!token;

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password);
    const result = persistAuthResponse(response);
    setToken(result.token);
    setUserState(result.user);
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const response = await api.signup(email, password);
    const result = persistAuthResponse(response);
    setToken(result.token);
    setUserState(result.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    setToken(null);
    setUserState(null);
  }, []);

  const setUser = useCallback((updatedUser: AuthUser) => {
    localStorage.setItem("auth_user", JSON.stringify(updatedUser));
    setUserState(updatedUser);
  }, []);

  return (
    <AuthContext.Provider
      value={{ token, user, isAuthenticated, login, signup, logout, setUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
