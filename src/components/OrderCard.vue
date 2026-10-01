<script setup lang="ts">
import { computed, ref } from "vue";
import { useFlowStore } from "../workflow/store";
import type { Order } from "../workflow/types";

const props = defineProps<{ order: Order }>();
const store = useFlowStore();

const selectedTruck = ref("");
const windowName = ref("装车窗口一");
const tareTons = ref<number | null>(null);
const grossTons = ref<number | null>(null);

const occupation = computed(() => store.occupationOf(props.order));
const truck = computed(() => store.truckOf(props.order));
const liveReceipts = computed(() => store.liveReceipts(props.order));
const net = computed(() => store.netTons(props.order));
const busyOrderId = computed(() =>
  selectedTruck.value ? store.truckBusyTruckId(selectedTruck.value) : undefined,
);
const selectedTruckExpired = computed(() =>
  selectedTruck.value ? store.truckExpired(selectedTruck.value) : false,
);

/** 可选用车：需具备该油品舱；装车位互斥与证件有效性在事务中再次校验 */
const eligibleTrucks = computed(() =>
  store.trucks.filter((t) => t.compartments.some((c) => c.fuel === props.order.fuel)),
);

const diffOpen = computed(() => props.order.status === "差异待复核");
const departed = computed(() => props.order.status === "已发车");

function statusClass(status: string): string {
  return {
    待确认: "st-draft",
    待重算: "st-recalc",
    已预占: "st-pre",
    已核销: "st-done",
    差异待复核: "st-diff",
    已发车: "st-go",
  }[status] ?? "st-draft";
}

function doConfirm() {
  if (!selectedTruck.value) return;
  store.confirmOrder(props.order.id, selectedTruck.value, windowName.value);
  selectedTruck.value = "";
}

function doRegister(kind: "皮重" | "毛重") {
  const tons = kind === "皮重" ? tareTons.value : grossTons.value;
  if (tons === null || Number.isNaN(tons)) return;
  store.registerReceipt(props.order.id, kind, Number(tons));
}

function scopeText(): string {
  const occ = occupation.value;
  if (!occ) return "未占用罐容";
  if (departed.value) {
    return `占用 ${occ.id} 已冻结留存（${occ.reservedTons}→${occ.actualTons ?? "-"} 吨）；罐车已释放`;
  }
  if (occ.status === "失效") {
    return `占用 ${occ.id} 已失效，重算范围：${props.order.recalc?.scope ?? "重新选车预占"}`;
  }
  if (occ.status === "核销") {
    return `占用 ${occ.id} 已核销：预占 ${occ.reservedTons} 吨 / 实装 ${occ.actualTons ?? "-"} 吨`;
  }
  return `占用 ${occ.id}：${occ.fuel} 预占 ${occ.reservedTons} 吨，等待回执核销`;
}
</script>

<template>
  <article class="order-card">
    <header class="oc-head">
      <div>
        <p class="oc-code">{{ order.code }}</p>
        <p class="oc-route">{{ order.station }} · {{ order.fuel }} · 计划 {{ order.plannedTons }} 吨 · {{ order.arriveAt }}</p>
      </div>
      <span class="status-pill" :class="statusClass(order.status)">{{ order.status }}</span>
    </header>

    <!-- 占用 / 差异 / 重算范围 -->
    <div class="oc-scope">
      <p v-if="truck">
        <span class="k">油罐车</span>{{ truck.plate }} / {{ truck.driver }} /
        证件至 {{ truck.licenseExpireAt }}
        <em v-if="store.truckExpired(truck.id) && !departed" class="warn">（已过期）</em>
      </p>
      <p><span class="k">占用</span>{{ scopeText() }}</p>
      <p v-if="order.diffTons !== undefined" :class="{ warn: diffOpen, ok: !diffOpen }">
        <span class="k">差异</span>
        {{ order.diffTons > 0 ? "+" : "" }}{{ order.diffTons.toFixed(2) }} 吨
        （容差 ±{{ store.db.tolerance }} 吨，{{ order.diffReviewed ? "已复核" : "未复核，禁止发车" }}）
      </p>
      <p v-if="order.recalc" class="recalc">
        <span class="k">重算范围</span>{{ order.recalc.reason }}；{{ order.recalc.scope }}
      </p>
    </div>

    <!-- 步骤一：确认前按油品预占罐容 -->
    <div v-if="['待确认', '待重算'].includes(order.status)" class="oc-action">
      <div class="confirm-row">
        <select v-model="windowName">
          <option>装车窗口一</option>
          <option>装车窗口二</option>
        </select>
        <select v-model="selectedTruck">
          <option value="" disabled>选择油罐车（按油品匹配舱容）</option>
          <option v-for="t in eligibleTrucks" :key="t.id" :value="t.id">
            {{ t.plate }} / {{ t.driver }} /
            {{ t.compartments.find((c) => c.fuel === order.fuel)?.fuel }}
            舱 {{ t.compartments.find((c) => c.fuel === order.fuel)?.capacity }} 吨
          </option>
        </select>
        <button type="button" :disabled="!selectedTruck" @click="doConfirm">确认并预占罐容</button>
      </div>
      <p v-if="selectedTruckExpired" class="hint warn">该司机证件已过期，确认将被拦截</p>
      <p v-else-if="busyOrderId" class="hint warn">该车正被另一未发车单占用，提交会触发窗口互斥</p>
    </div>

    <!-- 步骤二：地磅回执到齐后核销 -->
    <div v-if="order.status === '已预占'" class="oc-action">
      <div class="receipt-row">
        <label>皮重（车自重，吨）
          <input v-model.number="tareTons" type="number" min="0" step="0.1" placeholder="如 12" />
        </label>
        <button type="button" :disabled="tareTons === null" @click="doRegister('皮重')">登记皮重</button>
        <label>毛重（总重，吨）
          <input v-model.number="grossTons" type="number" min="0" step="0.1" placeholder="如 30" />
        </label>
        <button type="button" :disabled="grossTons === null" @click="doRegister('毛重')">登记毛重</button>
      </div>
      <div class="receipt-state">
        <span v-for="r in liveReceipts" :key="r.id" class="chip">{{ r.kind }} {{ r.actualTons }} 吨 ✓</span>
        <span class="chip dim">到齐 {{ liveReceipts.length }}/2</span>
        <span v-if="net !== null" class="chip">净重 {{ net }} 吨</span>
        <button type="button" :disabled="liveReceipts.length < 2" @click="store.settle(order.id)">
          回执到齐，核销占用
        </button>
      </div>
    </div>

    <!-- 步骤三：差异复核 -->
    <div v-if="diffOpen" class="oc-action gate">
      <p class="gate-text">⛔ 地磅差异 {{ order.diffTons?.toFixed(2) }} 吨超出容差，未复核不能发车</p>
      <button type="button" class="review-btn" @click="store.reviewDiff(order.id)">调度人工复核差异</button>
    </div>

    <!-- 步骤四：发车 -->
    <div v-if="order.status === '已核销'" class="oc-action">
      <button type="button" class="go-btn" @click="store.depart(order.id)">放行发车（依据冻结）</button>
    </div>

    <!-- 已发车 -->
    <div v-if="departed" class="oc-action frozen">
      <span class="chip ok">已发车 · 占用/差异/回执原依据保留</span>
      <span v-if="truck && store.truckExpired(truck.id)" class="chip">司机证件已过期：本单不重算</span>
    </div>

    <p v-if="order.note" class="oc-note">备注：{{ order.note }}</p>
  </article>
</template>
