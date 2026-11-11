<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import DashboardView from "./views/DashboardView.vue";
import AgentsView from "./views/AgentsView.vue";
import IntegrityView from "./views/IntegrityView.vue";
import LedgerView from "./views/LedgerView.vue";
import LoginView from "./views/LoginView.vue";
import ApprovalsView from "./views/ApprovalsView.vue";
import LocaleSwitch from "./LocaleSwitch.vue";
import { t, type MessageKey } from "./i18n";
import { call, logout, token } from "./session";
import type { Approval } from "./types";

type Tab = "dashboard" | "ledger" | "agents" | "approvals" | "integrity";

const tabs: { id: Tab; label: MessageKey }[] = [
  { id: "dashboard", label: "nav.dashboard" },
  { id: "ledger", label: "nav.ledger" },
  { id: "agents", label: "nav.agents" },
  { id: "approvals", label: "nav.approvals" },
  { id: "integrity", label: "nav.integrity" },
];
// A shared link such as /console/?tab=ledger&verdict=denied opens the matching section.
function initialTab(): Tab {
  try {
    const wanted = new URLSearchParams(location.search).get("tab");
    return tabs.find((tab) => tab.id === wanted)?.id ?? "dashboard";
  } catch {
    return "dashboard";
  }
}
const current = ref<Tab>(initialTab());

// Number of pending approval requests, refreshed every 5 seconds.
const pending = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
async function refreshPending() {
  if (!token.value) return;
  try {
    pending.value = (await call<{ approvals: Approval[] }>("/admin/approvals?status=pending&limit=500")).approvals.length;
  } catch {
    // the badge keeps its last value
  }
}

// Gateway enforcement mode, refreshed when the user logs in.
const mode = ref<"enforce" | "observe" | null>(null);
async function refreshMode() {
  try {
    const health = await fetch("/health").then((r) => r.json() as Promise<{ mode?: "enforce" | "observe" }>);
    mode.value = health.mode ?? "enforce";
  } catch {
    mode.value = null;
  }
}
onMounted(() => {
  void refreshPending();
  timer = setInterval(refreshPending, 5000);
});
onUnmounted(() => clearInterval(timer));
watch(token, () => {
  void refreshPending();
  void refreshMode();
});
</script>

<template>
  <LoginView v-if="!token" />
  <template v-else>
    <header class="topbar">
      <div class="topbar-inner">
        <span class="brand">Gardagent <span class="brand-sub">console</span></span>
        <span v-if="mode === 'observe'" class="badge badge-observe">{{ t("badge.observe") }}</span>
        <nav class="tabs" :aria-label="t('nav.label')">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            class="tab"
            :aria-current="current === tab.id ? 'page' : undefined"
            @click="current = tab.id"
          >
            {{ t(tab.label) }}
            <span v-if="tab.id === 'approvals' && pending > 0" class="tab-count" :aria-label="t('nav.pendingCount', { count: pending })">{{ pending }}</span>
          </button>
        </nav>
        <LocaleSwitch />
        <button type="button" class="btn btn-quiet" @click="logout()">{{ t("nav.logout") }}</button>
      </div>
    </header>
    <main class="page">
      <DashboardView v-if="current === 'dashboard'" />
      <LedgerView v-else-if="current === 'ledger'" />
      <AgentsView v-else-if="current === 'agents'" />
      <ApprovalsView v-else-if="current === 'approvals'" @changed="refreshPending" />
      <IntegrityView v-else />
    </main>
  </template>
</template>
