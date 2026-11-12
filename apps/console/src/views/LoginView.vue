<script setup lang="ts">
import { ref } from "vue";
import { api, ApiError } from "../api";
import LocaleSwitch from "../LocaleSwitch.vue";
import { t, type MessageKey } from "../i18n";
import { errorMessage, loginNotice, setToken } from "../session";

const value = ref("");
const busy = ref(false);
const error = ref("");
const errorKey = ref<MessageKey | "">("");

async function submit() {
  error.value = "";
  errorKey.value = "";
  const candidate = value.value.trim();
  if (!candidate) {
    errorKey.value = "login.required";
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
    if (e instanceof ApiError && e.kind === "unauthorized") errorKey.value = "error.invalidToken";
    else error.value = errorMessage(e);
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
      <p v-if="loginNotice && !error && !errorKey" class="alert alert-error" role="alert">{{ t(loginNotice) }}</p>
      <p v-if="errorKey || error" class="alert alert-error" role="alert">{{ errorKey ? t(errorKey) : error }}</p>
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
