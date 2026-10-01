<script setup lang="ts">
import { computed, ref } from "vue";
import { useFlowStore } from "../workflow/store";
import { stepsOf, type FailurePoint } from "../workflow/engine";
import type { TxnKind } from "../workflow/types";

const store = useFlowStore();

// 只演示对“确认预占”的双窗口竞争
const pendingOrders = computed(() =>
  store.orders.filter((o) => ["待确认", "待重算"].includes(o.status)),
);
const trucks = computed(() => store.trucks);

const simOrderId = ref("");
const simTruckId = ref("");
const injectFailure = ref(false);
const resultText = ref<string[]>([]);

const failureKinds: { kind: TxnKind; label: string }[] = [
  { kind: "confirm", label: "确认预占" },
  { kind: "settle", label: "回执核销" },
  { kind: "review", label: "差异复核" },
  { kind: "depart", label: "发车放行" },
  { kind: "recalc", label: "证件重算" },
];
const failKind = ref<TxnKind>("confirm");
const failStepId = ref("preallocate");

const failSteps = computed(() => stepsOf(failKind.value));

function onFailKindChange() {
  failStepId.value = failSteps.value[0]?.id ?? "";
  const point: FailurePoint = { kind: failKind.value, stepId: failStepId.value };
  store.setFailurePoint(point);
}

function armFailure() {
  store.setFailurePoint({ kind: failKind.value, stepId: failStepId.value });
}

function clearFailure() {
  store.setFailurePoint(null);
}

function runSimultaneous() {
  if (!simOrderId.value || !simTruckId.value) return;
  const result = store.confirmSimultaneous(simOrderId.value, simTruckId.value, injectFailure.value);
  const lines: string[] = [];
  for (const w of result.ok) lines.push(`✅ ${w}：预占放行成功`);
  for (const r of result.rejected) lines.push(`⛔ ${r.windowName}：${r.message}`);
  if (result.interrupted) {
    lines.push(`🔁 事务 ${result.interrupted.txnId} 在「${result.interrupted.failedStep}」写入中断，可从中断点恢复`);
  }
  resultText.value = lines;
}

function txnStatusClass(status: string) {
  return {
    已完成: "txn-ok",
    已中断: "txn-bad",
    已拒绝: "txn-rej",
    运行中: "txn-run",
  }[status] ?? "";
}

const KIND_LABEL: Record<TxnKind, string> = {
  confirm: "确认预占",
  settle: "回执核销",
  review: "差异复核",
  depart: "发车放行",
  recalc: "证件重算",
  setExpiry: "证件调整",
};
</script>

<template>
  <section class="side-panel sim">
    <h3>双窗口竞争 & 写入恢复演练</h3>

    <div class="sim-block">
      <p class="sim-title">① 两个窗口同时提交同一罐车</p>
      <select v-model="simOrderId">
        <option value="" disabled>选择待确认配送单</option>
        <option v-for="o in pendingOrders" :key="o.id" :value="o.id">
          {{ o.code }} / {{ o.fuel }} / {{ o.plannedTons }} 吨
        </option>
      </select>
      <select v-model="simTruckId">
        <option value="" disabled>选择被争抢的油罐车</option>
        <option v-for="t in trucks" :key="t.id" :value="t.id">{{ t.plate }} / {{ t.driver }}</option>
      </select>
      <label class="check">
        <input v-model="injectFailure" type="checkbox" />
        首单在写入时制造故障（验证断点恢复、不重复占车）
      </label>
      <button type="button" :disabled="!simOrderId || !simTruckId" @click="runSimultaneous">
        两窗口同时提交
      </button>
      <ul v-if="resultText.length" class="sim-result">
        <li v-for="(line, i) in resultText" :key="i">{{ line }}</li>
      </ul>
    </div>

    <div class="sim-block">
      <p class="sim-title">② 故障注入点（下次单窗口事务生效）</p>
      <div class="fail-row">
        <select v-model="failKind" @change="onFailKindChange">
          <option v-for="f in failureKinds" :key="f.kind" :value="f.kind">{{ f.label }}</option>
        </select>
        <select v-model="failStepId" @change="armFailure">
          <option v-for="s in failSteps" :key="s.id" :value="s.id">{{ s.label }}</option>
        </select>
      </div>
      <div class="fail-actions">
        <button type="button" class="mini" @click="armFailure">武装故障</button>
        <button type="button" class="mini secondary" @click="clearFailure">解除</button>
        <span class="chip" :class="store.failurePoint ? '' : 'dim'">
          {{ store.failurePoint
            ? `已武装：${KIND_LABEL[store.failurePoint.kind]} / ${store.failurePoint.stepId}`
            : "无故障注入" }}
        </span>
      </div>
    </div>

    <div v-if="store.pendingRecovery" class="recovery-banner">
      <p>🔁 检测到写入中断</p>
      <p class="hint">
        事务 {{ store.pendingRecovery.txnId }}（{{ store.pendingRecovery.windowName }}）
        断点：<b>{{ store.pendingRecovery.failedStep }}</b><br />
        {{ store.pendingRecovery.lastError }}
      </p>
      <button type="button" class="recover-btn" @click="store.recover()">从中断点恢复（不重复占车）</button>
    </div>

    <div class="sim-block">
      <p class="sim-title">③ WAL 事务日志（每步落库，前滚依据）</p>
      <div v-if="store.txns.length === 0" class="hint">暂无事务</div>
      <div v-for="t in store.txns.slice(0, 8)" :key="t.id" class="txn-row">
        <div class="txn-head">
          <span class="mono">{{ t.id }}</span>
          <span class="chip">{{ KIND_LABEL[t.kind] }}</span>
          <span class="txn-status" :class="txnStatusClass(t.status)">{{ t.status }}</span>
        </div>
        <div class="txn-steps">
          <span v-for="s in stepsOf(t.kind)" :key="s.id"
            class="step"
            :class="{
              done: t.doneSteps.includes(s.id),
              failed: t.failedStep === s.id,
            }">
            {{ s.label }}{{ t.doneSteps.includes(s.id) ? " ✓" : t.failedStep === s.id ? " ✗" : "" }}
          </span>
        </div>
        <p v-if="t.lastError" class="hint warn">{{ t.lastError }}</p>
      </div>
    </div>
  </section>
</template>
