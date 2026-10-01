<script setup lang="ts">
import { computed, ref } from "vue";
import { useFlowStore } from "./workflow/store";
import OrderCard from "./components/OrderCard.vue";
import CreateOrderForm from "./components/CreateOrderForm.vue";
import TruckPanel from "./components/TruckPanel.vue";
import SimPanel from "./components/SimPanel.vue";
import AuditPanel from "./components/AuditPanel.vue";

const store = useFlowStore();

const statusFilter = ref("全部");
const FLOW_ORDER = ["待确认", "已预占", "差异待复核", "已核销", "待重算", "已发车"] as const;

const filteredOrders = computed(() =>
  [...store.orders]
    .filter((o) => statusFilter.value === "全部" || o.status === statusFilter.value)
    .sort((a, b) => FLOW_ORDER.indexOf(a.status as (typeof FLOW_ORDER)[number]) -
      FLOW_ORDER.indexOf(b.status as (typeof FLOW_ORDER)[number])),
);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 油库装车可恢复流程</p>
          <h1>配送单 · 油罐车占用 · 地磅回执 联动</h1>
          <p class="subtitle">
            确认前按油品预占罐容，回执到齐核销，差异未复核不能发车；
            两窗口同时提交只放行一单，写入失败从中断点恢复、不重复占车；
            司机证件过期后未发车占用失效重算、已发车保留原依据。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span><span class="tag">Pinia</span>
          <span class="tag">WAL 前滚</span><span class="tag">localStorage 持久化</span>
        </div>
      </header>

      <section class="metrics">
        <article class="metric"><span>配送单</span><strong>{{ store.metrics.orders }}</strong></article>
        <article class="metric"><span>未发车预占</span><strong>{{ store.metrics.preallocated }}</strong></article>
        <article class="metric" :class="{ alert: store.metrics.pendingDiff > 0 }">
          <span>差异待复核</span><strong>{{ store.metrics.pendingDiff }}</strong>
        </article>
        <article class="metric"><span>已发车（依据冻结）</span><strong>{{ store.metrics.departed }}</strong></article>
        <article class="metric" :class="{ alert: store.metrics.recoverable > 0 }">
          <span>待恢复中断</span><strong>{{ store.metrics.recoverable }}</strong>
        </article>
      </section>

      <div v-if="store.lastMessage" class="toast" :class="store.lastMessage.type">
        {{ store.lastMessage.text }}
      </div>

      <section class="layout">
        <div class="left-col">
          <CreateOrderForm />
          <TruckPanel />
        </div>

        <div class="center-col">
          <section class="list-panel">
            <div class="toolbar">
              <h2>配送单流程列表</h2>
              <select v-model="statusFilter">
                <option>全部</option>
                <option v-for="s in FLOW_ORDER" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div class="order-list">
              <div v-if="filteredOrders.length === 0" class="empty">暂无匹配配送单</div>
              <OrderCard v-for="o in filteredOrders" :key="o.id" :order="o" />
            </div>
          </section>
          <AuditPanel />
        </div>

        <div class="right-col">
          <SimPanel />
        </div>
      </section>
    </div>
  </main>
</template>
