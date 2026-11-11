<script setup lang="ts">
import { onMounted, ref } from "vue";
import { budgetLabel, usd } from "../format";
import { t, type MessageKey } from "../i18n";
import { call, errorMessage } from "../session";
import type { Agent, CreatedAgent } from "../types";

const agents = ref<Agent[]>([]);
const loaded = ref(false);
const listError = ref("");
const busyId = ref("");

const name = ref("");
const models = ref("");
const budget = ref("");
const unlimited = ref(false);
const tools = ref("");
const approval = ref("");
const creating = ref(false);
const formError = ref("");

const createdKey = ref("");
const createdName = ref("");
// The key box title is derived from the kind and the name, so it follows the language.
const keyKind = ref<"created" | "rotated">("created");
const copyStatus = ref<MessageKey | "">("");
const keyField = ref<HTMLInputElement | null>(null);

// Inline editing of one agent at a time; confirmation before deactivation.
const editingId = ref("");
const editModels = ref("");
const editBudget = ref("0");
const editTools = ref("");
const editApproval = ref("");
const editError = ref("");
const confirmingId = ref("");
const rotatingId = ref("");

const parseModels = (text: string) =>
  text
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
// A <input type="number"> bound with v-model yields a number once the user has typed, a string otherwise.
/** A positive budget that rounds to 0 micro-USD would be stored as 0, i.e. "no cap": the gateway refuses it, so do we. */
const tooSmall = (usd: number) => usd > 0 && Math.round(usd * 1_000_000) === 0;
const parseBudget = (value: string | number) => (typeof value === "number" ? value : Number(value.replace(",", ".") || "0"));

async function refresh() {
  try {
    agents.value = (await call<{ agents: Agent[] }>("/admin/agents")).agents;
    listError.value = "";
  } catch (e) {
    listError.value = errorMessage(e);
  } finally {
    loaded.value = true;
  }
}

async function update(id: string, body: Record<string, unknown>): Promise<boolean> {
  busyId.value = id;
  try {
    await call(`/admin/agents/${id}`, { method: "PATCH", body });
    await refresh();
    return true;
  } catch (e) {
    listError.value = errorMessage(e);
    return false;
  } finally {
    busyId.value = "";
  }
}

function toggle(a: Agent) {
  rotatingId.value = "";
  if (a.active) confirmingId.value = a.id;
  else void update(a.id, { active: true });
}

async function confirmDisable(a: Agent) {
  confirmingId.value = "";
  await update(a.id, { active: false });
}

function startEdit(a: Agent) {
  editingId.value = a.id;
  editModels.value = a.allowedModels.join(", ");
  editBudget.value = String(a.dailyBudgetUsd);
  editTools.value = a.allowedTools.join(", ");
  editApproval.value = a.approvalTools.join(", ");
  editError.value = "";
  confirmingId.value = "";
  rotatingId.value = "";
}

async function confirmRotate(a: Agent) {
  rotatingId.value = "";
  busyId.value = a.id;
  try {
    const res = await call<CreatedAgent>(`/admin/agents/${a.id}/rotate-key`, { method: "POST" });
    createdKey.value = res.key;
    createdName.value = res.agent.name;
    keyKind.value = "rotated";
    copyStatus.value = "";
    listError.value = "";
  } catch (e) {
    listError.value = errorMessage(e);
  } finally {
    busyId.value = "";
  }
}

async function saveEdit(a: Agent) {
  const allowedModels = parseModels(editModels.value);
  const dailyBudgetUsd = parseBudget(editBudget.value);
  const allowedTools = parseModels(editTools.value);
  const approvalTools = parseModels(editApproval.value);
  if (allowedModels.length === 0) return void (editError.value = t("agents.errModels"));
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
    return void (editError.value = t("agents.errBudgetEdit"));
  }
  if (tooSmall(dailyBudgetUsd)) return void (editError.value = t("agents.errBudgetTiny"));
  if (await update(a.id, { allowedModels, allowedTools, approvalTools, dailyBudgetUsd })) editingId.value = "";
}

/** Share of daily budget already spent, as a percentage (0 if the budget is unlimited). */
function percent(a: Agent): number {
  return a.dailyBudgetUsd > 0 ? Math.min(100, (a.spentTodayUsd / a.dailyBudgetUsd) * 100) : 0;
}
const hot = (a: Agent) => a.dailyBudgetUsd > 0 && a.spentTodayUsd / a.dailyBudgetUsd > 0.8;

async function create() {
  formError.value = "";
  const allowedModels = parseModels(models.value);
  const dailyBudgetUsd = unlimited.value ? 0 : parseBudget(budget.value);
  const allowedTools = parseModels(tools.value);
  const approvalTools = parseModels(approval.value);
  if (!name.value.trim()) return void (formError.value = t("agents.errName"));
  if (allowedModels.length === 0) return void (formError.value = t("agents.errModels"));
  // A budget is required: either a positive amount or the explicit "no cap" box.
  if (!unlimited.value && (String(budget.value).trim() === "" || !Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0)) {
    return void (formError.value = t("agents.errBudgetCreate"));
  }
  if (tooSmall(dailyBudgetUsd)) return void (formError.value = t("agents.errBudgetTiny"));

  creating.value = true;
  try {
    const res = await call<CreatedAgent>("/admin/agents", {
      method: "POST",
      body: { name: name.value.trim(), allowedModels, allowedTools, approvalTools, dailyBudgetUsd, ...(unlimited.value ? { unlimited: true } : {}) },
    });
    createdKey.value = res.key;
    createdName.value = res.agent.name;
    keyKind.value = "created";
    copyStatus.value = "";
    name.value = "";
    models.value = "";
    tools.value = "";
    approval.value = "";
    budget.value = "";
    unlimited.value = false;
    await refresh();
  } catch (e) {
    formError.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(createdKey.value);
    copyStatus.value = "agents.copied";
  } catch {
    // Clipboard unavailable (insecure page, permission denied): manual selection.
    keyField.value?.select();
    copyStatus.value = "agents.copyFailed";
  }
}

onMounted(refresh);
</script>

<template>
  <section aria-labelledby="agents-title">
    <div class="section-head">
      <h1 id="agents-title">Agents</h1>
    </div>

    <div v-if="createdKey" class="panel key-box" role="status">
      <h2>{{ t(keyKind === "rotated" ? "agents.keyRotated" : "agents.keyCreated", { name: createdName }) }}</h2>
      <input ref="keyField" class="mono key-field" :value="createdKey" readonly :aria-label="t('agents.keyAria')" @focus="keyField?.select()" />
      <div class="row">
        <button type="button" class="btn btn-primary" @click="copyKey">{{ t("agents.copy") }}</button>
        <button type="button" class="btn" @click="createdKey = ''">{{ t("agents.noted") }}</button>
      </div>
      <p class="warn"><strong>{{ t("agents.keyOnce") }}</strong></p>
      <p v-if="keyKind === 'rotated'" class="warn">{{ t("agents.oldKeyDead") }}</p>
      <p v-if="copyStatus" class="hint">{{ t(copyStatus) }}</p>
    </div>

    <p v-if="listError" class="alert alert-error" role="alert">{{ listError }}</p>

    <div class="panel flush">
      <p v-if="!loaded" class="empty">{{ t("agents.loading") }}</p>
      <p v-else-if="agents.length === 0 && !listError" class="empty">{{ t("agents.empty") }}</p>
      <table v-else-if="agents.length > 0" class="table responsive">
        <thead>
          <tr>
            <th scope="col">{{ t("agents.colName") }}</th>
            <th scope="col">{{ t("agents.colModels") }}</th>
            <th scope="col">{{ t("agents.colTools") }}</th>
            <th scope="col">{{ t("agents.colApproval") }}</th>
            <th scope="col" class="num">{{ t("agents.colBudget") }}</th>
            <th scope="col">{{ t("agents.colSpend") }}</th>
            <th scope="col">{{ t("agents.colStatus") }}</th>
            <th scope="col">{{ t("agents.colActions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in agents" :key="a.id">
            <td :data-label="t('agents.colName')">{{ a.name }}</td>
            <td :data-label="t('agents.dlModels')" class="mono">
              <input v-if="editingId === a.id" v-model="editModels" class="inline-input" type="text" :aria-label="t('agents.editModelsAria')" />
              <template v-else>{{ a.allowedModels.join(", ") }}</template>
            </td>
            <td :data-label="t('agents.dlTools')" class="mono">
              <input
                v-if="editingId === a.id"
                v-model="editTools"
                class="inline-input"
                type="text"
                :placeholder="t('agents.toolPlaceholder')"
                :aria-label="t('agents.editToolsAria')"
              />
              <template v-else>{{ a.allowedTools.length ? a.allowedTools.join(", ") : t("common.none") }}</template>
            </td>
            <td :data-label="t('agents.dlApproval')" class="mono">
              <input
                v-if="editingId === a.id"
                v-model="editApproval"
                class="inline-input"
                type="text"
                :placeholder="t('agents.toolPlaceholder')"
                :aria-label="t('agents.editApprovalAria')"
              />
              <template v-else>{{ a.approvalTools.length ? a.approvalTools.join(", ") : t("common.none") }}</template>
            </td>
            <td :data-label="t('agents.dlBudget')" class="num mono">
              <input
                v-if="editingId === a.id"
                v-model="editBudget"
                class="inline-input"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.01"
                :aria-label="t('agents.editBudgetAria')"
              />
              <template v-else>{{ budgetLabel(a.dailyBudgetUsd) }}</template>
            </td>
            <td :data-label="t('agents.colSpend')" class="spend">
              <template v-if="a.dailyBudgetUsd > 0">
                <div
                  class="meter"
                  :class="{ hot: hot(a) }"
                  role="progressbar"
                  :aria-valuenow="Math.round(percent(a))"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  :aria-label="t('agents.spendAria', { name: a.name })"
                >
                  <span :style="{ width: percent(a) + '%' }"></span>
                </div>
                <span class="mono small" :class="{ bad: hot(a) }">{{ t("agents.spentOf", { spent: usd(a.spentTodayUsd), budget: usd(a.dailyBudgetUsd) }) }}</span>
                <span v-if="a.reservedTodayUsd > 0" class="mono small muted">{{ t("agents.reserved", { amount: usd(a.reservedTodayUsd) }) }}</span>
              </template>
              <span v-else class="mono small">{{ usd(a.spentTodayUsd) }} <span class="muted">{{ t("agents.noCap") }}</span></span>
            </td>
            <td :data-label="t('agents.colStatus')">
              <button
                type="button"
                class="switch"
                role="switch"
                :aria-checked="a.active"
                :aria-label="t('agents.switchAria', { name: a.name, state: a.active ? t('agents.stateActive') : t('agents.stateDisabled') })"
                :disabled="busyId === a.id"
                @click="toggle(a)"
              >
                <span class="knob" aria-hidden="true"></span>
                <span>{{ a.active ? t("agents.stateActive") : t("agents.stateInactive") }}</span>
              </button>
            </td>
            <td :data-label="t('agents.colActions')" class="actions">
              <div v-if="confirmingId === a.id" class="confirm" role="alertdialog" :aria-label="t('agents.disableTitle', { name: a.name })">
                <p>{{ t("agents.disableWarn") }}</p>
                <button type="button" class="btn btn-danger" @click="confirmDisable(a)">{{ t("agents.disable") }}</button>
                <button type="button" class="btn" @click="confirmingId = ''">{{ t("common.cancel") }}</button>
              </div>
              <template v-else-if="editingId === a.id">
                <p v-if="editError" class="alert alert-error" role="alert">{{ editError }}</p>
                <button type="button" class="btn btn-primary" :disabled="busyId === a.id" @click="saveEdit(a)">{{ t("agents.save") }}</button>
                <button type="button" class="btn" @click="editingId = ''">{{ t("common.cancel") }}</button>
              </template>
              <div v-else-if="rotatingId === a.id" class="confirm" role="alertdialog" :aria-label="t('agents.rotateTitle', { name: a.name })">
                <p>{{ t("agents.rotateWarn") }}</p>
                <button type="button" class="btn btn-danger" @click="confirmRotate(a)">{{ t("agents.rotate") }}</button>
                <button type="button" class="btn" @click="rotatingId = ''">{{ t("common.cancel") }}</button>
              </div>
              <template v-else>
                <button type="button" class="btn" @click="startEdit(a)">{{ t("agents.edit") }}</button>
                <button type="button" class="btn" :disabled="busyId === a.id" @click="rotatingId = a.id; confirmingId = ''">{{ t("agents.rotate") }}</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="panel form" @submit.prevent="create">
      <h2>{{ t("agents.createTitle") }}</h2>
      <p v-if="formError" class="alert alert-error" role="alert">{{ formError }}</p>
      <label class="field">
        <span>{{ t("agents.fName") }}</span>
        <input v-model="name" type="text" autocomplete="off" required />
      </label>
      <label class="field">
        <span>{{ t("agents.fModels") }}</span>
        <input v-model="models" type="text" autocomplete="off" placeholder="deepseek-v4.1-flash, minimax-m3" required />
        <small class="hint">{{ t("agents.fModelsHint") }}</small>
      </label>
      <label class="field">
        <span>{{ t("agents.fTools") }}</span>
        <input v-model="tools" type="text" autocomplete="off" :placeholder="t('agents.toolPlaceholder')" />
        <small class="hint">{{ t("agents.fToolsHint") }}</small>
      </label>
      <label class="field">
        <span>{{ t("agents.fApproval") }}</span>
        <input v-model="approval" type="text" autocomplete="off" :placeholder="t('agents.toolPlaceholder')" />
        <small class="hint">{{ t("agents.fApprovalHint") }}</small>
      </label>
      <label class="field">
        <span>{{ t("agents.fBudget") }}</span>
        <input v-model="budget" type="number" inputmode="decimal" min="0" step="0.01" :disabled="unlimited" :required="!unlimited" />
        <small class="hint">{{ t("agents.fBudgetHint") }}</small>
      </label>
      <label class="field">
        <span><input v-model="unlimited" type="checkbox" /> {{ t("agents.fUnlimited") }}</span>
        <small class="hint">{{ t("agents.fUnlimitedHint") }}</small>
      </label>
      <button type="submit" class="btn btn-primary" :disabled="creating">{{ creating ? t("agents.creating") : t("agents.create") }}</button>
    </form>
  </section>
</template>
