<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkflowStore } from "./store";
import ControlPanel from "./components/ControlPanel.vue";
import TruckBoard from "./components/TruckBoard.vue";
import OrderCard from "./components/OrderCard.vue";
import AuditLog from "./components/AuditLog.vue";

const store = useWorkflowStore();

const toast = ref<{ text: string; kind: "ok" | "err" } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, kind: "ok" | "err" = "ok") {
  toast.value = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 4200);
}

const filters = ["全部", "待确认", "预占中", "已预占", "差异待复核", "可发车", "占用失效", "已发车"] as const;
const filter = ref<(typeof filters)[number]>("全部");

const visibleOrders = computed(() => {
  if (filter.value === "全部") return store.orders;
  return store.orders.filter((o) => store.deriveStatus(o) === filter.value);
});

const metrics = computed(() => {
  const orders = store.state.orders;
  return [
    {
      label: "配送单总数",
      value: String(orders.length),
      sub: `待确认 ${orders.filter((o) => o.stage === "DRAFT").length}`,
      danger: false,
    },
    {
      label: "罐容预占(HELD)",
      value: `${store.heldLedgers.reduce((s, l) => s + l.tons, 0)}t`,
      sub: `${store.heldLedgers.length} 条占用台账`,
      danger: false,
    },
    {
      label: "差异待复核",
      value: String(orders.filter((o) => o.stage === "DISPUTED").length),
      sub: "未复核禁止发车",
      danger: orders.some((o) => o.stage === "DISPUTED"),
    },
    {
      label: "可发车 / 在途",
      value: `${orders.filter((o) => o.stage === "RELEASED").length} / ${orders.filter((o) => o.stage === "DISPATCHED").length}`,
      sub: "依据已固化",
      danger: false,
    },
  ];
});

const interrupted = computed(() => store.state.sagas.filter((s) => s.status === "FAILED"));
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 油库装车可恢复流程</p>
          <h1>配送单 → 油罐车占用 → 地磅回执核销</h1>
          <p class="subtitle">
            确认前按油品预占罐容，回执到齐核销；吨数差异未复核不能发车。两窗口同时提交只放行一单，
            写入失败可从中断点恢复且不重复占车；司机证件过期后未发车占用失效重算、已发车保留原依据。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Saga 断点恢复</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric" :class="{ alert: m.danger }">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
          <em>{{ m.sub }}</em>
        </article>
      </section>

      <div v-if="interrupted.length" class="interrupt-banner">
        ⚠ 有 {{ interrupted.length }} 个确认流程中断待恢复（
        <span v-for="(s, i) in interrupted" :key="s.id">
          {{ i > 0 ? "、" : "" }}{{ s.orderId }}@{{ s.failAtStep }}
        </span>
        ），窗口确认权被保留，恢复前其他单据无法提交。
      </div>

      <section class="workspace main-grid">
        <div class="col-left">
          <ControlPanel @toast="showToast" />
          <TruckBoard />
        </div>
        <div class="col-right">
          <section class="panel">
            <div class="panel-head wrap">
              <h2>配送单列表</h2>
              <div class="filter-row">
                <button
                  v-for="f in filters"
                  :key="f"
                  type="button"
                  class="chip"
                  :class="{ active: filter === f }"
                  @click="filter = f"
                >
                  {{ f }}
                </button>
              </div>
            </div>
            <div class="order-list">
              <OrderCard v-for="o in visibleOrders" :key="o.id" :order="o" @toast="showToast" />
              <p v-if="visibleOrders.length === 0" class="empty">该状态下暂无配送单</p>
            </div>
          </section>
        </div>
      </section>

      <AuditLog />

      <footer class="foot">
        数据保存在浏览器 localStorage（键 hxwlfront-19-oil-loading-workflow），用于演示可恢复的装车业务闭环。
      </footer>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast" :class="toast.kind">{{ toast.text }}</div>
    </transition>
  </main>
</template>
