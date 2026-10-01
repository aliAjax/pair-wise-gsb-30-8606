<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkflowStore } from "../store";
import { ACTION_META, fmtTime } from "./meta";

const store = useWorkflowStore();
const keyword = ref("");

const rows = computed(() =>
  store.state.audits.filter((a) => {
    if (!keyword.value.trim()) return true;
    const k = keyword.value.trim();
    return a.detail.includes(k) || a.scope?.includes(k) || a.orderId?.includes(k) || a.action.includes(k);
  })
);
</script>

<template>
  <section class="panel audit-panel">
    <div class="panel-head">
      <h2>审计记录（占用 / 差异 / 重算范围）</h2>
      <input v-model="keyword" class="audit-search" placeholder="搜索单号、动作、范围…" />
    </div>
    <div class="audit-table">
      <div class="audit-row audit-head-row">
        <span>时间</span>
        <span>动作</span>
        <span>窗口</span>
        <span>明细</span>
        <span>影响范围</span>
      </div>
      <div v-for="a in rows" :key="a.id" class="audit-row">
        <span class="au-time">{{ fmtTime(a.at) }}</span>
        <span><em class="au-tag" :class="ACTION_META[a.action].cls">{{ ACTION_META[a.action].label }}</em></span>
        <span>{{ a.window }}<template v-if="a.orderId"><br /><b class="au-order">{{ a.orderId }}</b></template></span>
        <span>{{ a.detail }}</span>
        <span class="au-scope">{{ a.scope ?? "—" }}</span>
      </div>
      <p v-if="rows.length === 0" class="empty">暂无审计记录</p>
    </div>
  </section>
</template>
