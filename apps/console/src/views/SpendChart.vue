<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { fullDay, shortDay, usd, usdNumber } from "../format";
import { t } from "../i18n";
import type { StatsAgent, StatsDay } from "../types";

const props = defineProps<{ days: StatsDay[]; agents: StatsAgent[] }>();

const HEIGHT = 240;
const PAD = { left: 56, right: 8, top: 10, bottom: 28 };
const PALETTE = ["#0F5E59", "#2F6DB5", "#B7791F", "#7A4FA3", "#3A9E96", "#A3456B", "#7A8B2E", "#56657A"];

const box = ref<HTMLElement | null>(null);
const width = ref(640);
const hovered = ref<string | null>(null);
let observer: ResizeObserver | undefined;

onMounted(() => {
  const measure = () => {
    if (box.value && box.value.clientWidth > 0) width.value = Math.max(280, box.value.clientWidth);
  };
  measure();
  if (typeof ResizeObserver !== "undefined" && box.value) {
    observer = new ResizeObserver(measure);
    observer.observe(box.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

const keyOf = (id: string | null) => id ?? "unknown";
const colors = computed(() => new Map(props.agents.map((a, i) => [keyOf(a.agentId), PALETTE[i % PALETTE.length]!])));
const labelOf = (a: { agentId: string | null; name: string | null }) => a.name ?? (a.agentId ? t("common.deletedAgent") : t("common.unknownKey"));

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const frac = max / exp;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * exp;
}

const top = computed(() => niceMax(Math.max(0, ...props.days.map((d) => d.spentUsd))));
const innerW = computed(() => width.value - PAD.left - PAD.right);
const innerH = HEIGHT - PAD.top - PAD.bottom;
const step = computed(() => innerW.value / Math.max(1, props.days.length));
const barW = computed(() => Math.max(2, step.value * 0.7));
const yOf = (v: number) => PAD.top + innerH - (v / top.value) * innerH;
const ticks = computed(() => [0, 1, 2, 3, 4].map((i) => (top.value * i) / 4));
const every = computed(() => (props.days.length <= 10 ? 1 : props.days.length <= 16 ? 2 : 5));

const bars = computed(() =>
  props.days.map((d, i) => {
    const x = PAD.left + i * step.value + (step.value - barW.value) / 2;
    let acc = 0;
    const segments = d.agents
      .filter((a) => a.spentUsd > 0)
      .map((a) => {
        const y1 = yOf(acc);
        acc += a.spentUsd;
        const y0 = yOf(acc);
        return { key: keyOf(a.agentId), color: colors.value.get(keyOf(a.agentId)) ?? "#56657A", y: y0, h: Math.max(0.5, y1 - y0) };
      });
    return { day: d, i, x, segments, label: shortDay(d.day), hit: PAD.left + i * step.value };
  }),
);

const readout = computed(() => {
  const d = props.days.find((x) => x.day === hovered.value);
  if (!d) return t("chart.hint");
  const parts = d.agents.filter((a) => a.spentUsd > 0).map((a) => `${labelOf(a)} ${usd(a.spentUsd)}`);
  return t("chart.readout", {
    date: fullDay(d.day),
    total: usd(d.spentUsd),
    parts: parts.length ? ` (${parts.join(", ")})` : "",
    allowed: d.allowed,
    denied: d.denied,
  });
});
</script>

<template>
  <div class="chart">
    <div ref="box" class="chart-box">
      <svg
        :viewBox="`0 0 ${width} ${HEIGHT}`"
        :width="width"
        :height="HEIGHT"
        role="img"
        :aria-label="t('chart.label')"
        @mouseleave="hovered = null"
      >
        <g v-for="tick in ticks" :key="tick">
          <line :x1="PAD.left" :x2="width - PAD.right" :y1="yOf(tick)" :y2="yOf(tick)" class="grid" />
          <text :x="PAD.left - 6" :y="yOf(tick) + 4" text-anchor="end" class="axis">{{ tick === 0 ? "0" : usdNumber(tick) }}</text>
        </g>
        <g v-for="b in bars" :key="b.day.day">
          <rect
            v-for="s in b.segments"
            :key="s.key"
            :x="b.x"
            :y="s.y"
            :width="barW"
            :height="s.h"
            :fill="s.color"
            :opacity="hovered && hovered !== b.day.day ? 0.45 : 1"
          />
          <text v-if="b.i % every === 0" :x="b.x + barW / 2" :y="HEIGHT - 8" text-anchor="middle" class="axis">{{ b.label }}</text>
          <!-- Hover zone covering the full height of the column -->
          <rect
            :x="b.hit"
            :y="PAD.top"
            :width="step"
            :height="innerH"
            fill="transparent"
            @mouseenter="hovered = b.day.day"
            @click="hovered = b.day.day"
          >
            <title>{{ t("chart.tooltip", { day: b.label, total: usd(b.day.spentUsd) }) }}</title>
          </rect>
        </g>
      </svg>
    </div>
    <p class="readout" role="status" aria-live="polite">{{ readout }}</p>
    <ul class="legend" :aria-label="t('chart.legend')">
      <li v-for="a in agents" :key="keyOf(a.agentId)">
        <span class="swatch" :style="{ background: colors.get(keyOf(a.agentId)) }" aria-hidden="true"></span>
        {{ labelOf(a) }} <span class="mono muted">{{ usd(a.spentUsd) }}</span>
      </li>
    </ul>
  </div>
</template>
