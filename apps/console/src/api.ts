import { t } from "./i18n";

export type ApiErrorKind = "unauthorized" | "network" | "http";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      return String((body.error as { message: unknown }).message);
    }
  } catch {
    // missing or unreadable body: generic message below
  }
  return t("error.http", { status: res.status });
}

/** Downloads a file from an /admin route (the token cannot travel through a plain link). */
export async function apiFile(path: string, token: string): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError("network", t("error.network"));
  }
  if (res.status === 401) throw new ApiError("unauthorized", t("error.invalidToken"), 401);
  if (!res.ok) throw new ApiError("http", await readError(res), res.status);
  const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
  return { blob: await res.blob(), filename: match?.[1] ?? "gardagent-journal.csv" };
}

/** Call to an /admin route with the token as Bearer. */
export async function api<T>(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("network", t("error.network"));
  }
  if (res.status === 401) throw new ApiError("unauthorized", t("error.invalidToken"), 401);
  if (!res.ok) throw new ApiError("http", await readError(res), res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("http", t("error.unreadable"), res.status);
  }
}
