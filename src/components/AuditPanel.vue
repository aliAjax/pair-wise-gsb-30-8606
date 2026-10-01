<script setup lang="ts">
import { ref } from "vue";
import { useFlowStore } from "../workflow/store";
import type { AuditEntry } from "../workflow/types";

const store = useFlowStore();
const keyword = ref("");
const ACTIONS = [
  "全部",
  "预占罐容",
  "窗口竞争失败",
  "回执登记",
  "回执到齐核销",
  "差异生成",
  "差异复核",
  "发车",
  "证件核查重算",
  "写入中断",
  "中断恢复",
] as const;
const actionFilter = ref<(typeof ACTIONS)[number]>("全部");

function actionClass(action: AuditEntry["action"]): string {
  return {
    预占罐容: "au-pre",
    窗口竞争失败: "au-conflict",
    回执到齐核销: "au-settle",
    差异生成: "au-diff",
    差异复核: "au-review",
    发车: "au-go",
    证件核查重算: "au-recalc",
    写入中断: "au-bad",
    中断恢复: "au-recover",
  }[action] ?? "au-default";
}

function timeOf(at: string): string {
  const d = new Date(at);
  return d.toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <section class="audit-panel">
    <header class="audit-head">
      <h3>审计记录（占用 · 差异 · 重算范围）</h3>
      <div class="audit-filters">
        <select v-model="actionFilter">
          <option v-for="a in ACTIONS" :key="a" :value="a">{{ a }}</option>
        </select>
        <input v-model="keyword" placeholder="搜索单号 / 车牌 / 占用ID" />
        <button type="button" class="mini secondary" @click="store.resetAll()">重置演示数据</button>
      </div>
    </header>

    <div class="audit-list">
      <div v-if="store.audits.length === 0" class="hint">暂无审计记录</div>
      <div
        v-for="a in store.audits.filter(
          (x) =>
            (actionFilter === '全部' || x.action === actionFilter) &&
            (!keyword || JSON.stringify(x).includes(keyword)),
        )"
        :key="a.id"
        class="audit-row"
        :class="{ recovered: a.recovered }"
      >
        <div class="audit-top">
          <span class="au-tag" :class="actionClass(a.action)">{{ a.action }}</span>
          <span class="audit-time">{{ timeOf(a.at) }}</span>
        </div>
        <p class="audit-detail">{{ a.detail }}</p>
        <p v-if="a.scope" class="audit-scope">影响范围：{{ a.scope }}</p>
      </div>
    </div>
  </section>
</template>
