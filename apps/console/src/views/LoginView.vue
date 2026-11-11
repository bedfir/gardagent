<script setup lang="ts">
import { ref } from "vue";
import { api, ApiError } from "../api";
import LocaleSwitch from "../LocaleSwitch.vue";
import { t } from "../i18n";
import { errorMessage, loginNotice, setToken } from "../session";

const value = ref("");
const busy = ref(false);
const error = ref("");

async function submit() {
  const candidate = value.value.trim();
  if (!candidate) {
    error.value = t("login.required");
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    // A read call is enough to validate the token.
    await api("/admin/agents", candidate);
    setToken(candidate);
    value.value = "";
  } catch (e) {
    error.value = e instanceof ApiError && e.kind === "unauthorized" ? t("error.invalidToken") : errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login">
    <div class="login-lang"><LocaleSwitch /></div>
    <form class="panel login-card" @submit.prevent="submit">
      <h1>Gardagent</h1>
      <p class="muted">{{ t("login.intro") }}</p>
      <p v-if="loginNotice && !error" class="alert alert-error" role="alert">{{ t(loginNotice) }}</p>
      <p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
      <label class="field">
        <span>{{ t("login.field") }}</span>
        <input v-model="value" type="password" autocomplete="off" spellcheck="false" autofocus />
      </label>
      <button type="submit" class="btn btn-primary" :disabled="busy">
        {{ busy ? t("login.checking") : t("login.submit") }}
      </button>
      <p class="hint">{{ t("login.hint") }}</p>
    </form>
  </main>
</template>
