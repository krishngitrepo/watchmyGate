/**
 * Browser API client.
 *
 * Static export means every request happens here, in the browser. Two consequences
 * worth being deliberate about:
 *
 * 1. **The API base URL is a runtime value, not a build-time one.** The same `out/`
 *    directory is packaged into the Tauri desktop app and served from a static host, and
 *    those point at different API origins. Baking it in at build time would mean two
 *    builds of identical code.
 *
 * 2. **Tokens live in memory plus sessionStorage, never localStorage.** localStorage
 *    survives the tab closing and is readable by any script on the origin; a
 *    committee laptop is frequently a shared laptop.
 */

const TOKEN_KEY = "wmg.access";
const REFRESH_KEY = "wmg.refresh";
const SOCIETY_KEY = "wmg.society";
const ROLES_KEY = "wmg.roles";
const SOCIETY_NAME_KEY = "wmg.societyName";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiBase(): string {
  if (typeof window === "undefined") return "";
  // Set by the deployment (a small config.js, or Tauri's injected global). Falls back
  // to the local API so `npm run dev` works with no configuration at all.
  const configured = (window as { __WMG_API__?: string }).__WMG_API__;
  return configured ?? "http://localhost:8080";
}

export const session = {
  token: (): string | null =>
    typeof window === "undefined" ? null : sessionStorage.getItem(TOKEN_KEY),
  refresh: (): string | null =>
    typeof window === "undefined" ? null : sessionStorage.getItem(REFRESH_KEY),
  societyId: (): string | null =>
    typeof window === "undefined" ? null : sessionStorage.getItem(SOCIETY_KEY),

  /**
   * The roles this person holds *in this society*.
   *
   * Kept only so the console can avoid offering an action that would certainly be
   * refused — an "Import" button that always returns 403 teaches people the product is
   * broken. It is **not** a security boundary: the API re-checks every role on every
   * request, and a token edited in devtools buys nothing but a different error message.
   */
  roles: (): string[] => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(sessionStorage.getItem(ROLES_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  },

  societyName: (): string =>
    (typeof window === "undefined" ? null : sessionStorage.getItem(SOCIETY_NAME_KEY)) ??
    "Your society",

  save(
    tokens: { accessToken: string; refreshToken: string },
    societyId: string,
    meta?: { roles?: string[]; societyName?: string },
  ): void {
    sessionStorage.setItem(TOKEN_KEY, tokens.accessToken);
    sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken);
    sessionStorage.setItem(SOCIETY_KEY, societyId);
    if (meta?.roles) sessionStorage.setItem(ROLES_KEY, JSON.stringify(meta.roles));
    if (meta?.societyName) sessionStorage.setItem(SOCIETY_NAME_KEY, meta.societyName);
  },

  clear(): void {
    for (const key of [TOKEN_KEY, REFRESH_KEY, SOCIETY_KEY, ROLES_KEY, SOCIETY_NAME_KEY]) {
      sessionStorage.removeItem(key);
    }
  },

  isSignedIn: (): boolean =>
    typeof window !== "undefined" && Boolean(sessionStorage.getItem(TOKEN_KEY)),
};

/** True when the signed-in person holds any of these roles in the current society. */
export function can(...roles: string[]): boolean {
  const held = session.roles();
  return roles.some((role) => held.includes(role));
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  retryOn401 = true,
): Promise<T> {
  const token = session.token();

  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  // Access tokens are short-lived by design. Rotating transparently on the first 401
  // means an accountant mid-way through a reconciliation is not thrown back to a login
  // screen — but only once, so a genuinely dead session does not loop.
  if (response.status === 401 && retryOn401 && session.refresh()) {
    const rotated = await tryRefresh();
    if (rotated) return request<T>(path, init, false);
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const err = (body as { error?: { message?: string; code?: string } }).error;
    throw new ApiError(
      err?.message ?? `Request failed (${response.status})`,
      response.status,
      err?.code,
    );
  }

  return body as T;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = session.refresh();
  const societyId = session.societyId();
  if (!refreshToken || !societyId) return false;

  try {
    const response = await fetch(`${apiBase()}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, societyId }),
    });
    if (!response.ok) {
      session.clear();
      return false;
    }
    const tokens = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    session.save(tokens, societyId);
    return true;
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", ...(body ? { body: JSON.stringify(body) } : {}) }),
};

// ------------------------------------------------------------------ money

/**
 * Format a rupee amount for display.
 *
 * Takes a **string**, never a number. The API returns money as a decimal string
 * precisely so it never passes through a JS float, and parsing it here to format it
 * would reintroduce the problem this whole stack is arranged to avoid — at the one
 * point where the number is about to be read by a human and believed.
 *
 * Grouping is Indian (lakh/crore): 12,34,567.89, not 1,234,567.89. A treasurer reading
 * Western grouping has to stop and count digits, which is exactly the friction that
 * makes people distrust a number.
 */
export function rupees(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";

  const negative = amount.startsWith("-");
  const bare = negative ? amount.slice(1) : amount;
  const [whole = "0", fraction = ""] = bare.split(".");

  // Indian grouping: last three digits, then pairs.
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`
    : last3;

  const paise = (fraction + "00").slice(0, 2);
  return `${negative ? "−" : ""}₹${grouped}.${paise}`;
}

/** True when a decimal string is greater than zero, without going through a float. */
export function isPositive(amount: string | null | undefined): boolean {
  if (!amount) return false;
  return /[1-9]/.test(amount.replace("-", "")) && !amount.startsWith("-");
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";

  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * How much of an SLA window is left, phrased for a human.
 *
 * Deliberately says "overdue by" rather than showing a negative number: a breached SLA
 * is the thing a committee must act on, and a minus sign in a table is easy to skim past.
 */
export function slaRemaining(dueAt: string | null | undefined): {
  label: string;
  tone: "settled" | "pending" | "arrears";
} {
  if (!dueAt) return { label: "—", tone: "quiet" as never };

  const ms = new Date(dueAt).getTime() - Date.now();
  const hours = ms / 3_600_000;

  if (hours < 0) {
    const over = Math.abs(hours);
    return {
      label: over < 24 ? `overdue ${Math.round(over)} hr` : `overdue ${Math.round(over / 24)} d`,
      tone: "arrears",
    };
  }
  if (hours < 4) return { label: `${Math.round(hours * 60)} min left`, tone: "pending" };
  if (hours < 48) return { label: `${Math.round(hours)} hr left`, tone: "pending" };
  return { label: `${Math.round(hours / 24)} d left`, tone: "settled" };
}
