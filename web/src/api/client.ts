const BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface AuthUser {
  id: number;
  email: string;
  accountHolderId: string | null;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export const api = {
  signup: (email: string, password: string): Promise<AuthResponse> =>
    request("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string): Promise<AuthResponse> =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: (): Promise<AuthUser> => request("/me"),
};
