<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { plural, reasonLabel, usd } from "../format";
import { t } from "../i18n";
import { call, errorMessage } from "../session";
import type { SpendCheck, Stats } from "../types";
import SpendChart from "./SpendChart.vue";

const periods = [7, 30];
const days = ref(7);
const stats = ref<Stats | null>(null);
const loading = ref(false);
const error = ref("");
const spendCheck = ref<SpendCheck | null>(null);

async function load() {
  loading.value = true;
  try {
    stats.value = await call<Stats>(`/admin/stats?days=${days.value}`);
    error.value = "";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

function choose(n: number) {
  if (n === days.value) return;
  days.value = n;
  void load();
}

const reasons = computed(() =>
  Object.entries(stats.value?.totals.deniedByReason ?? {}).sort((a, b) => b[1] - a[1]),
);
const hasActivity = computed(() => !!stats.value && stats.value.totals.allowed + stats.value.totals.denied > 0);

/** Best effort: a failing check never hides the dashboard. */
async function loadSpendCheck() {
  try {
    spendCheck.value = await call<SpendCheck>("/admin/spend-check");
  } catch {
    spendCheck.value = null;
  }
}

onMounted(() => {
  void load();
  void loadSpendCheck();
});
</script>

<template>
  <section aria-labelledby="dash-title">
    <div class="section-head">
      <h1 id="dash-title">{{ t("dash.title") }}</h1>
      <div class="segmented" role="group" :aria-label="t('dash.period')">
        <button
          v-for="n in periods"
          :key="n"
          type="button"
          class="seg"
          :aria-pressed="days === n"
          @click="choose(n)"
        >
          {{ t("dash.days", { n }) }}
        </button>
      </div>
    </div>

    <p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
    <p v-if="!stats && !error" class="empty">{{ t("dash.loading") }}</p>

    <div v-if="spendCheck && spendCheck.divergences.length > 0" class="notice" role="status">
      <h2>{{ t("dash.divergenceTitle", { agents: plural(spendCheck.divergences.length, t("unit.agent.one"), t("unit.agent.many")) }) }}</h2>
      <p class="muted">{{ t("dash.divergenceText") }}</p>
      <div class="scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{{ t("col.agent") }}</th>
              <th scope="col" class="num">{{ t("dash.colCounted") }}</th>
              <th scope="col" class="num">{{ t("dash.colLedgerSum") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in spendCheck.divergences" :key="d.agentId">
              <td>{{ d.name ?? d.agentId }}</td>
              <td class="num mono">{{ usd(d.spentUsd) }}</td>
              <td class="num mono">{{ usd(d.ledgerUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <template v-if="stats">
      <div class="tiles" :class="{ stale: loading }">
        <div class="panel tile">
          <span class="tile-label">{{ t("dash.tileCost", { days }) }}</span>
          <span class="tile-value mono">{{ usd(stats.totals.spentUsd) }}</span>
        </div>
        <div class="panel tile">
          <span class="tile-label">{{ t("dash.tileAllowed") }}</span>
          <span class="tile-value mono">{{ stats.totals.allowed }}</span>
        </div>
        <div class="panel tile">
          <span class="tile-label">{{ t("dash.tileDenied") }}</span>
          <span class="tile-value mono" :class="{ bad: stats.totals.denied > 0 }">{{ stats.totals.denied }}</span>
        </div>
      </div>

      <div class="panel">
        <h2>{{ t("dash.spendByDay") }}</h2>
        <p v-if="!hasActivity" class="muted">{{ t("dash.noActivity") }}</p>
        <SpendChart :days="stats.byDay" :agents="stats.agents" />
        <details class="detail">
          <summary>{{ t("dash.showTable") }}</summary>
          <div class="scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{{ t("dash.colDay") }}</th>
                  <th scope="col" class="num">{{ t("dash.colSpend") }}</th>
                  <th scope="col" class="num">{{ t("dash.colAllowed") }}</th>
                  <th scope="col" class="num">{{ t("dash.colDenied") }}</th>
                  <th scope="col" class="num">{{ t("col.tokens") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in [...stats.byDay].reverse()" :key="d.day">
                  <td class="mono">{{ d.day }}</td>
                  <td class="num mono">{{ usd(d.spentUsd) }}</td>
                  <td class="num mono">{{ d.allowed }}</td>
                  <td class="num mono">{{ d.denied }}</td>
                  <td class="num mono">{{ d.promptTokens }} / {{ d.completionTokens }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </div>

      <div class="panel">
        <h2>{{ t("dash.deniedByReason") }}</h2>
        <p v-if="reasons.length === 0" class="muted">{{ t("dash.noDenials") }}</p>
        <ul v-else class="reasons">
          <li v-for="[reason, n] in reasons" :key="reason">
            <span>{{ reasonLabel(reason) }}</span>
            <span class="mono">{{ plural(n, t("unit.denial.one"), t("unit.denial.many")) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
