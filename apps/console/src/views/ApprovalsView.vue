<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ageLabel, localTime } from "../format";
import { t } from "../i18n";
import { call, errorMessage } from "../session";
import type { Agent, Approval } from "../types";

const emit = defineEmits<{ changed: [] }>();

const approvals = ref<Approval[]>([]);
const names = ref<Record<string, string>>({});
const loaded = ref(false);
const error = ref("");
const busyId = ref("");
const rejectingId = ref("");
const rejectReason = ref("");
const now = ref(Date.now());

// Oldest first (they expire first); history: last 20 decisions.
const pending = computed(() => approvals.value.filter((a) => a.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
const history = computed(() =>
  approvals.value
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
    .slice(0, 20),
);

const agentName = (id: string) => names.value[id] ?? id;
const statusLabel = (a: Approval) => (a.status === "approved" ? t("approvals.approved") : a.status === "rejected" ? t("approvals.rejected") : t("approvals.expired"));
const accessLabel = (a: Approval) => (a.accessClass === "write" ? t("approvals.write") : t("approvals.read"));

async function refresh() {
  now.value = Date.now();
  try {
    const [list, agents] = await Promise.all([
      call<{ approvals: Approval[] }>("/admin/approvals?limit=200"),
      call<{ agents: Agent[] }>("/admin/agents"),
    ]);
    approvals.value = list.approvals;
    names.value = Object.fromEntries(agents.agents.map((a) => [a.id, a.name]));
    error.value = "";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loaded.value = true;
  }
}

async function decide(a: Approval, action: "approve" | "reject") {
  busyId.value = a.id;
  try {
    await call(`/admin/approvals/${a.id}/${action}`, {
      method: "POST",
      body: action === "reject" ? { reason: rejectReason.value.trim() } : {},
    });
    rejectingId.value = "";
    rejectReason.value = "";
    error.value = "";
  } catch (e) {
    // 409: already decided elsewhere; the refreshed list will show it.
    error.value = errorMessage(e);
  } finally {
    busyId.value = "";
    await refresh();
    emit("changed");
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  timer = setInterval(refresh, 5000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section aria-labelledby="approvals-title">
    <div class="section-head">
      <h1 id="approvals-title">{{ t("approvals.title") }}</h1>
    </div>

    <p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>

    <div class="panel flush">
      <p v-if="!loaded" class="empty">{{ t("approvals.loading") }}</p>
      <p v-else-if="pending.length === 0" class="empty">{{ t("approvals.none") }}</p>
      <table v-else class="table responsive">
        <thead>
          <tr>
            <th scope="col">{{ t("col.agent") }}</th>
            <th scope="col">{{ t("col.tool") }}</th>
            <th scope="col">{{ t("col.operator") }}</th>
            <th scope="col">{{ t("col.policyRev") }}</th>
            <th scope="col">{{ t("col.args") }}</th>
            <th scope="col">{{ t("col.age") }}</th>
            <th scope="col">{{ t("col.decision") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in pending" :key="a.id">
            <td :data-label="t('col.agent')">{{ agentName(a.agentId) }}</td>
            <td :data-label="t('col.tool')" class="mono">{{ a.server }}/{{ a.tool }} <span class="badge" :class="a.accessClass === 'write' ? 'badge-ko' : 'badge-ok'">{{ accessLabel(a) }}</span></td>
            <td :data-label="t('col.operator')" class="mono small">{{ a.operatorId ?? "—" }}</td>
            <td :data-label="t('col.policyRev')" class="mono small" style="overflow-wrap: anywhere">{{ a.policyRev ?? "—" }}</td>
            <td :data-label="t('col.args')" class="mono small">{{ a.argsSummary || t("common.noneArgs") }}</td>
            <td :data-label="t('col.age')" class="mono">{{ ageLabel(a.createdAt, now) }}</td>
            <td :data-label="t('col.decision')" class="actions">
              <template v-if="rejectingId === a.id">
                <input v-model="rejectReason" class="inline-input reject-reason" type="text" maxlength="500" :placeholder="t('approvals.reasonPlaceholder')" :aria-label="t('approvals.reasonAria')" />
                <button type="button" class="btn btn-danger" :disabled="busyId === a.id" @click="decide(a, 'reject')">{{ t("approvals.confirmReject") }}</button>
                <button type="button" class="btn" @click="rejectingId = ''">{{ t("common.cancel") }}</button>
              </template>
              <template v-else>
                <button type="button" class="btn btn-primary" :disabled="busyId === a.id" @click="decide(a, 'approve')">{{ t("approvals.approve") }}</button>
                <button type="button" class="btn" :disabled="busyId === a.id" @click="((rejectingId = a.id), (rejectReason = ''))">{{ t("approvals.reject") }}</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-head">
      <h2>{{ t("approvals.history") }}</h2>
    </div>
    <div class="panel flush">
      <p v-if="loaded && history.length === 0" class="empty">{{ t("approvals.noHistory") }}</p>
      <table v-else-if="history.length > 0" class="table responsive">
        <thead>
          <tr>
            <th scope="col">{{ t("col.decidedAt") }}</th>
            <th scope="col">{{ t("col.agent") }}</th>
            <th scope="col">{{ t("col.tool") }}</th>
            <th scope="col">{{ t("col.operator") }}</th>
            <th scope="col">{{ t("col.policyRev") }}</th>
            <th scope="col">{{ t("col.args") }}</th>
            <th scope="col">{{ t("col.result") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in history" :key="a.id">
            <td :data-label="t('col.decidedAt')" class="mono small">{{ a.decidedAt ? localTime(a.decidedAt) : "" }}</td>
            <td :data-label="t('col.agent')">{{ agentName(a.agentId) }}</td>
            <td :data-label="t('col.tool')" class="mono">{{ a.server }}/{{ a.tool }} <span class="badge" :class="a.accessClass === 'write' ? 'badge-ko' : 'badge-ok'">{{ accessLabel(a) }}</span></td>
            <td :data-label="t('col.operator')" class="mono small">{{ a.operatorId ?? "—" }}</td>
            <td :data-label="t('col.policyRev')" class="mono small" style="overflow-wrap: anywhere">{{ a.policyRev ?? "—" }}</td>
            <td :data-label="t('col.args')" class="mono small">{{ a.argsSummary || t("common.noneArgs") }}</td>
            <td :data-label="t('col.result')">
              {{ statusLabel(a) }}<template v-if="a.reason && a.status === 'rejected'"> : {{ a.reason }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
