<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { adminLabel, clockTime, costUsd, localTime, reasonLabel } from "../format";
import { t } from "../i18n";
import { call, callFile, errorMessage } from "../session";
import {
  EMPTY_FILTERS,
  FILTER_KEYS,
  filtersFromSearch,
  filtersToParams,
  hasActiveFilters,
  sameFilters,
  validateFilters,
  type LedgerFilters,
} from "../ledger-filters";
import type { Agent, LedgerEntry, LedgerFacets } from "../types";

const PAGE = 100;
const MAX_PAGE = 1000;
const REFRESH_MS = 10_000;

// Most recent rows at the top: the list is kept in descending seq order.
const rows = ref<LedgerEntry[]>([]);
const agents = ref<Agent[]>([]);
const hasOlder = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref("");
const updatedAt = ref<Date | null>(null);

// Filters: `draft` is what the fields show, `applied` what the list, the CSV export and the URL use.
const initial = filtersFromSearch(typeof location === "undefined" ? "" : location.search);
const draft = reactive<LedgerFilters>({ ...initial });
const applied = ref<LedgerFilters>({ ...initial });
const filterError = ref(validateFilters(initial));
const facets = ref<LedgerFacets>({ agents: [], models: [] });
const filtersActive = computed(() => hasActiveFilters(applied.value));

// Incremented on each filter change so a slow answer for old filters is never displayed.
let generation = 0;
let busy = false;
let busyGeneration = -1;
let timer: ReturnType<typeof setInterval> | undefined;

const agentNames = computed(() => new Map(agents.value.map((a) => [a.id, a.name])));

function agentLabel(id: string | null): string {
  return (id && agentNames.value.get(id)) || t("common.unknownKey");
}

/** Agent selector options: agents present in the ledger, plus the selected one if the URL names another. */
const agentOptions = computed(() => {
  const options = facets.value.agents.map((a) => ({ id: a.id, label: a.name ?? t("common.unknownKeyId", { id: a.id.slice(0, 8) }) }));
  const current = draft.agent;
  if (current && !options.some((o) => o.id === current)) {
    options.push({ id: current, label: agentNames.value.get(current) ?? t("common.unknownKeyId", { id: current.slice(0, 8) }) });
  }
  return options;
});
const modelOptions = computed(() => (draft.model && !facets.value.models.includes(draft.model) ? [...facets.value.models, draft.model] : facets.value.models));

/** Gateway query for the list: the applied filters plus the paging parameters. */
function listQuery(extra: Record<string, string | number>): string {
  const params = filtersToParams(applied.value);
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return `/admin/ledger?${params}`;
}

/** Keeps the page URL in step with the applied filters so the view can be shared or reloaded. */
function syncUrl() {
  try {
    // Parameters the page does not own are kept.
    const params = new URLSearchParams(location.search);
    for (const key of FILTER_KEYS) params.delete(key);
    for (const [key, value] of filtersToParams(applied.value)) params.set(key, value);
    params.set("tab", "ledger");
    history.replaceState(history.state, "", `${location.pathname}?${params}${location.hash}`);
  } catch {
    // history unavailable: filters still work, they just are not in the URL
  }
}

function clearUrl() {
  try {
    const params = new URLSearchParams(location.search);
    params.delete("tab");
    for (const key of FILTER_KEYS) params.delete(key);
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  } catch {
    // nothing to do
  }
}

function applyFilters() {
  filterError.value = validateFilters(draft);
  if (filterError.value) return;
  if (sameFilters(draft, applied.value)) return;
  applied.value = { ...draft };
  syncUrl();
  generation++;
  rows.value = [];
  hasOlder.value = false;
  loaded.value = false;
  void load("refresh");
}

function resetFilters() {
  Object.assign(draft, EMPTY_FILTERS);
  applyFilters();
  filterError.value = "";
}

async function loadFacets() {
  try {
    facets.value = await call<LedgerFacets>("/admin/ledger/facets");
  } catch {
    // the selectors keep what they had; the list itself reports errors
  }
}

function details(r: LedgerEntry): string {
  return adminLabel(r.action, r.reason) ?? reasonLabel(r.reason);
}

// CSV export: free period, last 30 days by default (UTC days, like the ledger).
const isoDay = (offsetDays: number) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
const exportFrom = ref(isoDay(30));
const exportTo = ref(isoDay(0));
const exporting = ref(false);
const exportError = ref("");

async function exportCsv() {
  exportError.value = "";
  if (exportFrom.value && exportTo.value && exportFrom.value > exportTo.value) {
    exportError.value = t("ledger.exportRange");
    return;
  }
  exporting.value = true;
  try {
    const query = filtersToParams(applied.value);
    if (exportFrom.value) query.set("from", exportFrom.value);
    if (exportTo.value) query.set("to", exportTo.value);
    const { blob, filename } = await callFile(`/admin/ledger/export.csv?${query}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    exportError.value = errorMessage(e);
  } finally {
    exporting.value = false;
  }
}

type Mode = "refresh" | "older";

async function load(mode: Mode) {
  if (busy && busyGeneration === generation) return;
  if (filterError.value) {
    // Filters from the URL that the gateway would reject: show the message instead of an empty list.
    loaded.value = true;
    return;
  }
  const mine = generation;
  busy = true;
  busyGeneration = mine;
  loading.value = true;
  try {
    const newest = rows.value[0]?.seq;
    const oldest = rows.value.at(-1)?.seq;
    // Answers are applied only if the filters did not change meanwhile (`mine === generation`).
    if (mode === "older" && oldest !== undefined) {
      const page = await call<{ entries: LedgerEntry[] }>(listQuery({ order: "desc", beforeSeq: oldest, limit: PAGE }));
      if (mine !== generation) return;
      rows.value.push(...page.entries);
      hasOlder.value = page.entries.length === PAGE;
    } else if (newest === undefined) {
      // First load: the last PAGE rows, most recent first.
      const page = await call<{ entries: LedgerEntry[] }>(listQuery({ order: "desc", limit: PAGE }));
      if (mine !== generation) return;
      rows.value = page.entries;
      hasOlder.value = page.entries.length === PAGE;
    } else {
      // Refresh: rows newer than the first displayed one, read in ascending order.
      let after = newest;
      for (;;) {
        const page = await call<{ entries: LedgerEntry[] }>(listQuery({ afterSeq: after, limit: MAX_PAGE }));
        if (mine !== generation) return;
        if (page.entries.length === 0) break;
        rows.value.unshift(...[...page.entries].reverse());
        after = page.entries.at(-1)!.seq;
        if (page.entries.length < MAX_PAGE) break;
      }
    }
    const names = (await call<{ agents: Agent[] }>("/admin/agents")).agents;
    if (mine !== generation) return;
    agents.value = names;
    error.value = "";
    updatedAt.value = new Date();
    loaded.value = true;
  } catch (e) {
    if (mine === generation) error.value = errorMessage(e);
  } finally {
    if (busyGeneration === mine) {
      busy = false;
      loading.value = false;
    }
  }
}

onMounted(() => {
  if (!filterError.value) syncUrl();
  void loadFacets();
  void load("refresh");
  timer = setInterval(() => void load("refresh"), REFRESH_MS);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  generation++;
  clearUrl();
});
</script>

<template>
  <section aria-labelledby="ledger-title">
    <div class="section-head">
      <h1 id="ledger-title">{{ t("ledger.title") }}</h1>
      <span class="live" :class="{ busy: loading }" role="status">
        <span class="dot" aria-hidden="true"></span>
        {{ t("ledger.live") }}<template v-if="updatedAt"> · {{ t("ledger.lastAt", { time: clockTime(updatedAt) }) }}</template>
      </span>
    </div>

    <form class="panel export filters" role="search" :aria-label="t('ledger.filters')" @submit.prevent="applyFilters">
      <label class="field">
        <span>{{ t("ledger.fAgent") }}</span>
        <select v-model="draft.agent" @change="applyFilters">
          <option value="">{{ t("common.all") }}</option>
          <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ t("ledger.fModel") }}</span>
        <select v-model="draft.model" @change="applyFilters">
          <option value="">{{ t("common.all") }}</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ t("ledger.fVerdict") }}</span>
        <select v-model="draft.verdict" @change="applyFilters">
          <option value="">{{ t("common.all") }}</option>
          <option value="allowed">{{ t("ledger.allowedOpt") }}</option>
          <option value="denied">{{ t("ledger.deniedOpt") }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ t("ledger.fMinCost") }}</span>
        <input v-model="draft.minCost" type="text" inputmode="decimal" autocomplete="off" :placeholder="t('ledger.costPlaceholder')" @change="applyFilters" />
      </label>
      <label class="field">
        <span>{{ t("ledger.fMaxCost") }}</span>
        <input v-model="draft.maxCost" type="text" inputmode="decimal" autocomplete="off" :placeholder="t('ledger.costPlaceholder')" @change="applyFilters" />
      </label>
      <button type="submit" class="btn">{{ t("ledger.filter") }}</button>
      <button type="button" class="btn btn-quiet" :disabled="!filtersActive && !hasActiveFilters(draft)" @click="resetFilters">{{ t("ledger.reset") }}</button>
      <p v-if="filterError" class="alert alert-error" role="alert">{{ filterError }}</p>
    </form>

    <form class="panel export" @submit.prevent="exportCsv">
      <label class="field">
        <span>{{ t("ledger.exportFrom") }}</span>
        <input v-model="exportFrom" type="date" />
      </label>
      <label class="field">
        <span>{{ t("ledger.exportTo") }}</span>
        <input v-model="exportTo" type="date" />
      </label>
      <button type="submit" class="btn" :disabled="exporting">{{ exporting ? t("ledger.exporting") : t("ledger.export") }}</button>
      <p v-if="filtersActive" class="muted export-note">{{ t("ledger.exportNote") }}</p>
      <p v-if="exportError" class="alert alert-error" role="alert">{{ exportError }}</p>
    </form>

    <p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>

    <div class="panel flush">
      <p v-if="loaded && rows.length === 0 && filtersActive" class="empty">{{ t("ledger.emptyFiltered") }}</p>
      <p v-else-if="loaded && rows.length === 0" class="empty">{{ t("ledger.empty") }}</p>
      <p v-else-if="!loaded && !error" class="empty">{{ t("ledger.loading") }}</p>
      <table v-else-if="rows.length > 0" class="table responsive">
        <thead>
          <tr>
            <th scope="col" class="num">{{ t("col.seq") }}</th>
            <th scope="col">{{ t("col.time") }}</th>
            <th scope="col">{{ t("col.agent") }}</th>
            <th scope="col">{{ t("col.model") }}</th>
            <th scope="col">{{ t("col.verdict") }}</th>
            <th scope="col">{{ t("col.reason") }}</th>
            <th scope="col" class="num">{{ t("col.tokens") }}</th>
            <th scope="col" class="num">{{ t("col.cost") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.seq">
            <td :data-label="t('col.seq')" class="num mono">{{ r.seq }}</td>
            <td :data-label="t('col.time')">{{ localTime(r.ts) }}</td>
            <td :data-label="t('col.agent')" :class="{ muted: !r.agentId || !agentNames.has(r.agentId) }">{{ agentLabel(r.agentId) }}</td>
            <td :data-label="t('col.model')" class="mono">{{ r.model ?? "—" }}</td>
            <td :data-label="t('col.verdict')">
              <span class="badge" :class="r.verdict === 'allowed' ? 'badge-ok' : 'badge-ko'">
                {{ r.verdict === "allowed" ? t("ledger.verdictAllowed") : t("ledger.verdictDenied") }}
              </span>
            </td>
            <td :data-label="t('col.reason')">{{ details(r) || "—" }}</td>
            <td :data-label="t('col.tokensShort')" class="num mono">{{ r.promptTokens }} / {{ r.completionTokens }}</td>
            <td :data-label="t('col.cost')" class="num mono">{{ costUsd(r.cost) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="hasOlder" class="more">
      <button type="button" class="btn" :disabled="loading" @click="load('older')">{{ t("ledger.older") }}</button>
    </div>
  </section>
</template>
