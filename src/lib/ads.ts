import { db } from "./db";
import { decrypt } from "./crypto";
import { DEFAULT_API_VERSION, env, opt } from "./env";

export class AdsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type GaqlRow = Record<string, unknown>;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** One Google Ads account this user can reach, and how to reach it. */
export interface AccountInfo {
  id: string;
  name: string;
  manager: boolean;
  status: string;
  currency: string;
  timeZone: string;
  /** true = the signed-in Google user has direct access (no login-customer-id needed) */
  direct: boolean;
  /** Manager (MCC) account that reaches this account when there is no direct access */
  viaManager: string | null;
}

interface AccessIndex {
  at: number;
  accounts: Map<string, AccountInfo>;
}

// Account -> how-to-reach map per user. Rebuilt every 30 minutes, or when a call is refused.
const accessCache = new Map<string, AccessIndex>();
const accessBuilds = new Map<string, Promise<AccessIndex>>();
const ACCESS_TTL_MS = 30 * 60 * 1000;
const ACCESS_MIN_REFRESH_MS = 10_000;

function networkError(error: unknown): never {
  if (error instanceof AdsError) throw error;
  const detail = error instanceof Error ? error.message : String(error);
  throw new AdsError(`Could not reach Google (${detail}). Retry in a moment.`, 502);
}

interface GoogleErrorBody {
  error?: { message?: string; status?: string; details?: { errors?: { message?: string }[] }[] };
}

function describeError(status: number, body: GoogleErrorBody): string {
  const detail = body.error?.details?.flatMap(d => d.errors ?? []).map(e => e.message).filter(Boolean).join("; ");
  const base = detail || body.error?.message || `HTTP ${status}`;
  switch (status) {
    case 401:
      return `Authentication failed: ${base}. Remove and re-add the connector in Claude to sign in with Google again.`;
    case 403:
      return `Permission denied: ${base}. Check that your Google user can access this customer, that the manager (MCC) account is right (gads_whoami shows it), and that your Cloud project has Google Ads API access.`;
    case 404:
      return `Not found: ${base}. Check the customer/resource IDs and GOOGLE_ADS_API_VERSION.`;
    case 429:
      return `Rate limit exceeded: ${base}. Wait a minute and retry with a narrower query.`;
    default:
      return `Google Ads API error (HTTP ${status}): ${base}`;
  }
}

export const normalizeCustomerId = (id: string): string => id.replace(/-/g, "");

/** Google Ads client bound to one signed-in user. Created per MCP request. */
export function makeAds(userId: string) {
  let userRow: Promise<{ email: string; google_refresh_token_enc: string | null; login_customer_id: string | null }> | undefined;
  const loadUser = () =>
    (userRow ??= (async () => {
      const { data, error } = await db().from("users").select("email, google_refresh_token_enc, login_customer_id").eq("id", userId).single();
      if (error || !data) throw new AdsError("Signed-in user not found. Remove and re-add the connector in Claude.", 401);
      return data;
    })());

  async function getAccessToken(signal: AbortSignal): Promise<string> {
    const hit = tokenCache.get(userId);
    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
    const user = await loadUser();
    if (!user.google_refresh_token_enc) throw new AdsError("No Google login saved. Remove and re-add the connector in Claude.", 401);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        refresh_token: decrypt(user.google_refresh_token_enc),
        grant_type: "refresh_token"
      }),
      signal
    }).catch(networkError);
    if (!res.ok) {
      throw new AdsError("Google rejected the saved login (it may have been revoked or expired). Remove and re-add the connector in Claude to sign in again.", res.status);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache.set(userId, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  }

  /** Manager (MCC) account used as login-customer-id: env override first, then the one detected at sign-in. */
  async function getDefaultLoginId(): Promise<string | undefined> {
    return opt("GOOGLE_ADS_LOGIN_CUSTOMER_ID") || (await loadUser()).login_customer_id || undefined;
  }

  /** Builds the account -> MCC map: every directly accessible account, plus everything under each manager. */
  async function buildAccessIndex(signal: AbortSignal): Promise<AccessIndex> {
    const list = await adsFetch<{ resourceNames?: string[] }>("customers:listAccessibleCustomers", { method: "GET", loginCustomerId: null, signal });
    const ids = (list.resourceNames ?? []).map(r => r.replace("customers/", "")).slice(0, 60);
    const accounts = new Map<string, AccountInfo>();
    const query =
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.currency_code, customer_client.time_zone FROM customer_client";

    const upsert = (id: string): AccountInfo => {
      let a = accounts.get(id);
      if (!a) {
        a = { id, name: "", manager: false, status: "UNKNOWN", currency: "", timeZone: "", direct: false, viaManager: null };
        accounts.set(id, a);
      }
      return a;
    };

    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const settled = await Promise.allSettled(
        batch.map(id =>
          adsFetch<{ results?: GaqlRow[] }>(`customers/${id}/googleAds:search`, { body: { query }, loginCustomerId: id, signal }).then(r => ({ id, rows: r.results ?? [] }))
        )
      );
      settled.forEach((res, n) => {
        const root = batch[n];
        upsert(root).direct = true;
        if (res.status !== "fulfilled") return; // e.g. a canceled account: still listed, just without details
        for (const row of res.value.rows) {
          const cc = (row as { customerClient?: Record<string, unknown> }).customerClient;
          if (!cc) continue;
          const cid = String(cc.id);
          const a = upsert(cid);
          a.name = String(cc.descriptiveName ?? a.name);
          a.manager = Boolean(cc.manager);
          a.status = String(cc.status ?? a.status);
          a.currency = String(cc.currencyCode ?? a.currency);
          a.timeZone = String(cc.timeZone ?? a.timeZone);
          if (cid !== root && !a.viaManager) a.viaManager = root;
        }
      });
    }
    return { at: Date.now(), accounts };
  }

  function refreshAccessIndex(signal: AbortSignal): Promise<AccessIndex> {
    let build = accessBuilds.get(userId);
    if (!build) {
      build = buildAccessIndex(signal)
        .then(idx => {
          accessCache.set(userId, idx);
          return idx;
        })
        .finally(() => accessBuilds.delete(userId));
      accessBuilds.set(userId, build);
    }
    return build;
  }

  async function getAccessIndex(signal: AbortSignal, force = false): Promise<AccessIndex> {
    const hit = accessCache.get(userId);
    if (hit && !force && Date.now() - hit.at < ACCESS_TTL_MS) return hit;
    if (hit && force && Date.now() - hit.at < ACCESS_MIN_REFRESH_MS) return hit;
    return refreshAccessIndex(signal);
  }

  /** Which login-customer-id to send for a client account: null = none (direct access). */
  async function resolveLogin(customerId: string, signal: AbortSignal, force = false): Promise<string | null> {
    const id = normalizeCustomerId(customerId);
    let idx = await getAccessIndex(signal, force);
    let acc = idx.accounts.get(id);
    if (!acc && !force) {
      idx = await getAccessIndex(signal, true); // maybe a newly added account
      acc = idx.accounts.get(id);
    }
    if (acc) return acc.direct ? null : acc.viaManager;
    return (await getDefaultLoginId()) ?? null;
  }

  async function adsFetch<T>(
    path: string,
    opts: { method?: "GET" | "POST"; body?: unknown; loginCustomerId?: string | null; signal: AbortSignal }
  ): Promise<T> {
    const version = opt("GOOGLE_ADS_API_VERSION") || DEFAULT_API_VERSION;
    const token = await getAccessToken(opts.signal);

    const send = async (login: string | null | undefined): Promise<T> => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const dev = opt("GOOGLE_ADS_DEVELOPER_TOKEN");
      if (dev) headers["developer-token"] = dev;
      if (login) headers["login-customer-id"] = normalizeCustomerId(login);

      let res: Response;
      try {
        res = await fetch(`https://googleads.googleapis.com/${version}/${path}`, {
          method: opts.method ?? "POST",
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)])
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new AdsError("The Google Ads API did not respond within 30 seconds. Retry, or narrow the query.", 504);
        }
        return networkError(error);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
        throw new AdsError(describeError(res.status, body), res.status);
      }
      return (await res.json()) as T;
    };

    // Explicit value (string = that MCC, null = send none) wins. Otherwise route automatically:
    // calls on customers/<id>/... use the right MCC for that account; everything else uses the default MCC.
    if (opts.loginCustomerId !== undefined) return send(opts.loginCustomerId);
    const m = /^customers\/(\d{10})(?=[/:]|$)/.exec(path);
    if (!m) return send(await getDefaultLoginId());
    const login = await resolveLogin(m[1], opts.signal);
    try {
      return await send(login);
    } catch (error) {
      if (error instanceof AdsError && error.status === 403) {
        const fresh = await resolveLogin(m[1], opts.signal, true).catch(() => login);
        if (fresh !== login) return send(fresh);
      }
      throw error;
    }
  }

  async function gaqlSearch(
    customerId: string,
    query: string,
    opts: { pageSize?: number; pageToken?: string; loginCustomerId?: string; signal: AbortSignal }
  ): Promise<{ rows: GaqlRow[]; nextPageToken?: string; total?: number }> {
    const data = await adsFetch<{ results?: GaqlRow[]; nextPageToken?: string; totalResultsCount?: string }>(
      `customers/${normalizeCustomerId(customerId)}/googleAds:search`,
      {
        // Send only fields every API version accepts (newer versions dropped returnTotalResultsCount / pageSize);
        // row limits are applied client-side or with LIMIT in the query.
        body: { query, ...(opts.pageToken ? { pageToken: opts.pageToken } : {}) },
        loginCustomerId: opts.loginCustomerId,
        signal: opts.signal
      }
    );
    return { rows: data.results ?? [], nextPageToken: data.nextPageToken, total: data.totalResultsCount === undefined ? undefined : Number(data.totalResultsCount) };
  }

  /** Runs a GAQL query and follows page tokens (up to maxPages pages) so bulk tools see every row. */
  async function gaqlAll(customerId: string, query: string, opts: { maxPages?: number; loginCustomerId?: string; signal: AbortSignal }): Promise<GaqlRow[]> {
    const rows: GaqlRow[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < (opts.maxPages ?? 10); page++) {
      const res = await gaqlSearch(customerId, query, { pageToken, loginCustomerId: opts.loginCustomerId, signal: opts.signal });
      rows.push(...res.rows);
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  function assertWritesAllowed(validateOnly: boolean): void {
    if (!validateOnly && opt("ALLOW_WRITES") !== "true") {
      throw new AdsError(
        'Writes are disabled on this server. Run with validate_only=true to preview, or set the ALLOW_WRITES environment variable to "true" in Vercel (then redeploy) to allow real changes.',
        403
      );
    }
  }

  /** Audit trail: console (Vercel logs) + audit_log table. Best effort, never blocks a change. */
  async function audit(entry: Record<string, unknown>): Promise<void> {
    const full = { audit: "google_ads_write", ts: new Date().toISOString(), ...entry };
    console.log(JSON.stringify(full));
    try {
      await db().from("audit_log").insert({ user_id: userId, entry: full });
    } catch {
      /* logging must not break the request */
    }
  }

  /** Calls <service>:mutate. service = any REST mutate service, "customers", or "googleAds" (atomic batch). */
  async function mutate(
    customerId: string,
    service: string,
    operations: unknown[],
    validateOnly: boolean,
    signal: AbortSignal,
    opts: { partialFailure?: boolean; loginCustomerId?: string } = {}
  ): Promise<unknown> {
    assertWritesAllowed(validateOnly);
    const id = normalizeCustomerId(customerId);
    const path = service === "customers" ? `customers/${id}:mutate` : `customers/${id}/${service}:mutate`;
    const key = service === "googleAds" ? "mutateOperations" : "operations";
    const result = await adsFetch<unknown>(path, {
      body: { [key]: operations, validateOnly, partialFailure: opts.partialFailure ?? false },
      loginCustomerId: opts.loginCustomerId,
      signal
    });
    await audit({ customerId: id, service, validateOnly, operations });
    return result;
  }

  async function getUserInfo() {
    const u = await loadUser();
    return { email: u.email, loginCustomerId: await getDefaultLoginId(), writesEnabled: opt("ALLOW_WRITES") === "true" };
  }

  return { adsFetch, gaqlSearch, gaqlAll, mutate, assertWritesAllowed, audit, getDefaultLoginId, getUserInfo, getAccessIndex, resolveLogin };
}

export type Ads = ReturnType<typeof makeAds>;

/** After sign-in: find a manager (MCC) account among the accounts this user can access and remember it. Best effort. */
export async function detectLoginCustomer(userId: string): Promise<void> {
  const api = makeAds(userId);
  const signal = AbortSignal.timeout(25_000);
  try {
    const list = await api.adsFetch<{ resourceNames?: string[] }>("customers:listAccessibleCustomers", { method: "GET", loginCustomerId: null, signal });
    for (const rn of (list.resourceNames ?? []).slice(0, 20)) {
      const id = rn.replace("customers/", "");
      try {
        const { rows } = await api.gaqlSearch(id, "SELECT customer.id, customer.manager FROM customer LIMIT 1", { loginCustomerId: id, signal });
        if ((rows[0] as { customer?: { manager?: boolean } } | undefined)?.customer?.manager) {
          await db().from("users").update({ login_customer_id: id }).eq("id", userId);
          return;
        }
      } catch {
        /* skip accounts that can't be queried directly */
      }
    }
  } catch {
    /* detection is best-effort; the MCC can also be set with GOOGLE_ADS_LOGIN_CUSTOMER_ID */
  }
}
