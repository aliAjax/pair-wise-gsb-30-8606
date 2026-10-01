<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useWorkflowStore } from "../store";
import type { Order } from "../types";
import { STATUS_META, fmtTime } from "./meta";

const props = defineProps<{ order: Order }>();
const emit = defineEmits<{ (e: "toast", text: string, kind?: "ok" | "err"): void }>();

const store = useWorkflowStore();

const status = computed(() => store.deriveStatus(props.order));
const meta = computed(() => STATUS_META[status.value]);
const truck = computed(() => store.state.trucks.find((t) => t.id === props.order.truckId));
const candidates = computed(() => store.candidateTrucks(props.order));
const net = computed(() => store.netTons(props.order));
const complete = computed(() => store.receiptsComplete(props.order));

const choice = reactive({ truckId: "" });
watch(
  () => props.order.id,
  () => {
    choice.truckId = candidates.value[0]?.id ?? "";
  },
  { immediate: true }
);

const receipt = reactive({
  tare: null as number | null,
  gross: null as number | null,
  tareCode: "",
  grossCode: "",
});

const reviewForm = reactive({ reviewer: "值班主管", comment: "" });

const previewDiff = computed(() => {
  if (receipt.tare === null || receipt.gross === null) return null;
  const n = Math.round((receipt.gross - receipt.tare) * 100) / 100;
  return { net: n, diff: Math.round((n - props.order.tons) * 100) / 100 };
});

const activeSaga = computed(() =>
  store.state.sagas.find((s) => s.orderId === props.order.id && s.status === "FAILED")
);

function notify(result: { ok: boolean; error?: string }, okText: string) {
  emit("toast", result.ok ? okText : result.error ?? "操作失败", result.ok ? "ok" : "err");
}

function confirm() {
  if (!choice.truckId) {
    emit("toast", "请选择油罐车", "err");
    return;
  }
  notify(store.confirmOrder(props.order, choice.truckId, props.order.window), "确认成功，罐容已预占");
}

function resume() {
  const saga = activeSaga.value;
  if (!saga) return;
  notify(store.resumeConfirm(saga.id), "已从中断点恢复并完成预占，未重复占车");
}

function abort() {
  const saga = activeSaga.value;
  if (!saga) return;
  store.abortSaga(saga.id);
  emit("toast", "已放弃恢复，确认权释放", "ok");
}

function register(kind: "TARE" | "GROSS") {
  const weight = kind === "TARE" ? receipt.tare : receipt.gross;
  const code = (kind === "TARE" ? receipt.tareCode : receipt.grossCode) || `WB-${kind}-${Date.now()}`;
  if (weight === null || weight <= 0) {
    emit("toast", "请输入有效地磅重量", "err");
    return;
  }
  const res = store.registerReceipt(props.order, {
    code,
    kind,
    weight,
    meteredAt: new Date().toISOString(),
  });
  notify(res, kind === "TARE" ? "皮重回执已登记" : "毛重回执已登记，系统执行核销判断");
}

function review(verdict: "APPROVED" | "REJECTED") {
  notify(
    store.reviewVariance(props.order, verdict, reviewForm.reviewer, reviewForm.comment || "现场确认"),
    verdict === "APPROVED" ? "差异复核通过，已核销" : "差异已驳回，退回补正回执"
  );
}

function dispatch() {
  notify(store.dispatch(props.order), "已发车，原始依据固化");
}

const canConfirm = computed(() => ["DRAFT", "INVALIDATED"].includes(props.order.stage));
</script>

<template>
  <article class="order-card" :class="`card-${order.stage.toLowerCase()}`">
    <header class="card-head">
      <div>
        <h3>{{ order.no }}</h3>
        <p class="card-sub">{{ order.station }} · {{ order.fuel }} · 计划 {{ order.tons }}t · {{ order.arriveAt }}</p>
      </div>
      <span class="status-pill" :class="meta.cls">{{ meta.text }}</span>
    </header>

    <div class="kv">
      <span>确认窗口：{{ order.window }}</span>
      <span v-if="truck">承运车辆：{{ truck.plate }}（{{ truck.id }}）</span>
      <span v-else-if="order.dispatchedTruckId">
        承运车辆：{{ store.state.trucks.find((t) => t.id === order.dispatchedTruckId)?.plate }}（已发车）
      </span>
      <span>创建：{{ fmtTime(order.createdAt) }}</span>
    </div>

    <!-- 占用信息 -->
    <div class="box box-hold">
      <template v-if="order.stage === 'DISPATCHED'">
        <p class="box-title">已发车 · 原始依据保留</p>
        <p class="box-line">{{ order.basisSnapshot }}</p>
        <p class="box-line muted">发车时间：{{ order.dispatchedAt && fmtTime(order.dispatchedAt) }}</p>
      </template>
      <template v-else-if="order.stage === 'INVALIDATED'">
        <p class="box-title text-danger">占用已失效（{{ fmtTime(order.recalcAt ?? order.createdAt) }}）</p>
        <p class="box-line text-danger">{{ order.invalidReason }}</p>
        <div v-if="order.recalcScope" class="recalc">
          <p class="box-title">重算范围</p>
          <p class="box-line">同批受影响：{{ order.recalcScope.orderIds.length }} 单；释放罐容 {{ order.recalcScope.freedTons }}t</p>
          <ul>
            <li v-for="(s, i) in order.recalcScope.suggestions" :key="i">{{ s }}</li>
          </ul>
        </div>
      </template>
      <template v-else-if="truck">
        <p class="box-title">
          罐容占用：按 {{ order.fuel }} 预占 {{ order.tons }}t
          <em v-if="['RESERVED', 'RECEIVED', 'DISPUTED'].includes(order.stage)">（HELD）</em>
          <em v-else-if="order.stage === 'RELEASED'">（已核销释放）</em>
        </p>
        <p class="box-line muted">
          车辆剩余可分配 {{ store.availableTons(truck) }}t / 核定 {{ truck.capacity }}t
        </p>
      </template>
      <p v-else class="box-line muted">尚未占用车辆与罐容</p>
    </div>

    <!-- 中断恢复 -->
    <div v-if="activeSaga" class="box box-fail">
      <p class="box-title">流程中断：{{ activeSaga.failAtStep }}</p>
      <p class="box-line">{{ activeSaga.failReason }}</p>
      <p class="box-line muted">
        已完成：{{ activeSaga.doneSteps.join(" → ") || "无" }}；台账
        {{ activeSaga.ledgerId ? "已写入（恢复时跳过，不重复占车）" : "未写入" }}
      </p>
      <div class="row-actions">
        <button type="button" @click="resume">从中断点恢复</button>
        <button type="button" class="secondary" @click="abort">放弃恢复</button>
      </div>
    </div>

    <!-- 确认选车 -->
    <div v-if="canConfirm && !activeSaga" class="box">
      <label class="inline-label">
        选择油罐车
        <select v-model="choice.truckId">
          <option v-for="t in candidates" :key="t.id" :value="t.id">
            {{ t.id }} {{ t.plate }}（剩 {{ store.availableTons(t) }}t）
          </option>
        </select>
      </label>
      <p v-if="candidates.length === 0" class="text-danger">无合规车辆（证件/油品/罐容/占用均不满足）</p>
      <div class="row-actions">
        <button type="button" :disabled="candidates.length === 0" @click="confirm">
          确认并按油品预占罐容
        </button>
      </div>
    </div>

    <!-- 回执登记 -->
    <div v-if="['RESERVED', 'RECEIVED', 'DISPUTED'].includes(order.stage)" class="box box-receipt">
      <p class="box-title">地磅回执（皮重+毛重到齐后核销）</p>
      <div class="receipt-row">
        <label>
          皮重(t)
          <input v-model.number="receipt.tare" type="number" step="0.1" placeholder="如 12.4" />
        </label>
        <button type="button" class="secondary" @click="register('TARE')">
          {{ order.receipts.some((r) => r.kind === "TARE") ? "改写皮重" : "登记皮重" }}
        </button>
      </div>
      <div class="receipt-row">
        <label>
          毛重(t)
          <input v-model.number="receipt.gross" type="number" step="0.1" placeholder="如 30.6" />
        </label>
        <button type="button" class="secondary" @click="register('GROSS')">
          {{ order.receipts.some((r) => r.kind === "GROSS") ? "改写毛重" : "登记毛重" }}
        </button>
      </div>
      <p v-if="previewDiff" class="box-line">
        输入预览：净重 {{ previewDiff.net }}t，差异 {{ previewDiff.diff }}t
        （容差 ±{{ order.review?.tolerance ?? 0.3 }}t）
      </p>
    </div>

    <!-- 核销/差异结果 -->
    <div v-if="order.receipts.length" class="box" :class="order.stage === 'DISPUTED' ? 'box-fail' : 'box-ok'">
      <p class="box-title">
        回执：皮重 {{ order.receipts.find((r) => r.kind === "TARE")?.weight ?? "—" }}t /
        毛重 {{ order.receipts.find((r) => r.kind === "GROSS")?.weight ?? "—" }}t
        <span v-if="complete">｜净重 {{ net }}t</span>
        <span v-else class="muted">｜回执未到齐</span>
      </p>
      <div v-if="order.review" class="variance">
        <p class="box-line">
          差异 {{ order.review.diff }}t（计划 {{ order.review.planned }}t，容差 ±{{ order.review.tolerance }}t）
          <span :class="Math.abs(order.review.diff) <= order.review.tolerance ? 'text-ok' : 'text-danger'">
            {{ Math.abs(order.review.diff) <= order.review.tolerance ? "容差内" : "超容差" }}
          </span>
        </p>
        <p class="box-line muted">复核：{{ order.review.reviewer }} · {{ order.review.comment }}</p>
      </div>

      <div v-if="order.stage === 'DISPUTED'" class="review-form">
        <label class="inline-label">
          复核人
          <input v-model="reviewForm.reviewer" />
        </label>
        <label class="inline-label grow">
          复核意见
          <input v-model="reviewForm.comment" placeholder="说明差异原因，未复核不能发车" />
        </label>
        <div class="row-actions">
          <button type="button" @click="review('APPROVED')">复核通过并核销</button>
          <button type="button" class="secondary" @click="review('REJECTED')">驳回·退回补正</button>
        </div>
      </div>
    </div>

    <!-- 发车 -->
    <div v-if="order.stage === 'RELEASED'" class="row-actions">
      <button type="button" @click="dispatch">放行发车</button>
      <span class="muted small">已核销，发车后依据固化</span>
    </div>
    <div v-else-if="order.stage === 'DISPATCHED'" class="row-actions">
      <span class="text-ok small">✔ 在途，占用台账已关闭，依据不再变化</span>
    </div>
  </article>
</template>
