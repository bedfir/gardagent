<script setup lang="ts">
import { ref } from "vue";
import { plural, problemLabel } from "../format";
import { t } from "../i18n";
import { call, errorMessage } from "../session";
import type { VerifyResult } from "../types";

const running = ref(false);
const result = ref<VerifyResult | null>(null);
const error = ref("");

async function verify() {
  running.value = true;
  error.value = "";
  result.value = null;
  try {
    result.value = await call<VerifyResult>("/admin/ledger/verify");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <section aria-labelledby="integrity-title">
    <div class="section-head">
      <h1 id="integrity-title">{{ t("integrity.title") }}</h1>
    </div>
    <div class="panel">
      <p>
        {{ t("integrity.intro") }}
      </p>
      <button type="button" class="btn btn-primary" :disabled="running" @click="verify">
        {{ running ? t("integrity.running") : t("integrity.verify") }}
      </button>

      <div class="result" role="status" aria-live="polite">
        <p v-if="error" class="alert alert-error">{{ error }}</p>
        <p v-else-if="result && result.valid" class="alert alert-ok">
          {{ t("integrity.ok", { checked: plural(result.checked, t("unit.row.one"), t("unit.row.many")) }) }}
        </p>
        <p v-else-if="result" class="alert alert-error">
          {{ t("integrity.broken", { seq: result.brokenAtSeq ?? "", problem: problemLabel(result.problem) }) }}
        </p>
        <p v-if="result && result.valid && result.lastHash" class="hint">
          {{ t("integrity.lastHash") }} <span class="mono hash">{{ result.lastHash }}</span>
        </p>
      </div>
    </div>
  </section>
</template>
