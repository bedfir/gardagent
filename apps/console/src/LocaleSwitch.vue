<script setup lang="ts">
import { LOCALES, locale, setLocale, t, type Locale } from "./i18n";

const NAMES: Record<Locale, string> = { fr: "Français", en: "English" };
</script>

<template>
  <div class="segmented lang-switch" role="group" :aria-label="t('lang.label')">
    <button
      v-for="l in LOCALES"
      :key="l"
      type="button"
      class="seg"
      :lang="l"
      :title="NAMES[l]"
      :aria-label="NAMES[l]"
      :aria-pressed="locale === l"
      @click="setLocale(l)"
    >
      {{ l.toUpperCase() }}
    </button>
  </div>
</template>
