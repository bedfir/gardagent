import { ref } from "vue";
import { api, apiFile, ApiError } from "./api";
import { t, type MessageKey } from "./i18n";

const STORAGE_KEY = "gardagent.adminToken";

function readStored(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export const token = ref(readStored());
/** Dictionary key of the message shown on the login screen (e.g. "error.invalidToken"); translated when displayed. */
export const loginNotice = ref<MessageKey | "">("");

export function setToken(value: string): void {
  token.value = value;
  loginNotice.value = "";
  try {
    sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage unavailable: the session will not survive reload
  }
}

export function logout(notice: MessageKey | "" = ""): void {
  token.value = "";
  loginNotice.value = notice;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}

/** Authenticated call; a 401 returns to the login screen. */
export async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  try {
    return await api<T>(path, token.value, init);
  } catch (e) {
    if (e instanceof ApiError && e.kind === "unauthorized") logout("error.invalidToken");
    throw e;
  }
}

export async function callFile(path: string): Promise<{ blob: Blob; filename: string }> {
  try {
    return await apiFile(path, token.value);
  } catch (e) {
    if (e instanceof ApiError && e.kind === "unauthorized") logout("error.invalidToken");
    throw e;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : t("error.unexpected");
}
