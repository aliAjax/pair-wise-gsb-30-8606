<script setup lang="ts">
import { reactive } from "vue";
import { useWorkflowStore, armLedgerWriteFailure } from "../store";
import { FUELS } from "../types";

const emit = defineEmits<{ (e: "toast", text: string, kind?: "ok" | "err"): void }>();

const store = useWorkflowStore();

const form = reactive({
  station: "城东站",
  fuel: FUELS[0],
  tons: 12,
  arriveAt: new Date().toISOString().slice(0, 10),
  window: "窗口1",
});

function create() {
  if (form.tons <= 0) {
    emit("toast", "配送吨数必须大于 0", "err");
    return;
  }
  const o = store.createOrder({ ...form });
  emit("toast", `已创建 ${o.no}，请在列表确认并预占`, "ok");
}

/** 模拟两窗口同时抢同一辆油罐车 */
function simulateContention() {
  const truck = store.state.trucks.find(
    (t) => !store.state.orders.some((o) => o.truckId === t.id && o.stage !== "DISPATCHED")
  );
  if (!truck) {
    emit("toast", "当前没有空闲车，可先重置演示数据", "err");
    return;
  }
  const a = store.createOrder({
    station: "城东站",
    fuel: truck.fuels[0],
    tons: Math.min(8, truck.capacity),
    arriveAt: form.arriveAt,
    window: "窗口1",
  });
  const b = store.createOrder({
    station: "机场站",
    fuel: truck.fuels[0],
    tons: Math.min(8, truck.capacity),
    arriveAt: form.arriveAt,
    window: "窗口2",
  });
  // 两个窗口在同一提交批次里确认同一辆车：只允许一单进入并提交
  const r1 = store.confirmOrder(a, truck.id, "窗口1");
  const r2 = store.confirmOrder(b, truck.id, "窗口2");
  emit(
    "toast",
    `窗口1：${r1.ok ? "放行" : r1.error} ｜ 窗口2：${r2.ok ? "放行" : "已拦截（" + r2.error + "）"}`,
    r1.ok && !r2.ok ? "ok" : "err"
  );
}

/** 模拟确认过程中台账写入故障：产生一条“预占中”的可恢复流程 */
function simulateWriteFailure() {
  const order = store.state.orders.find((o) => o.stage === "DRAFT");
  const candidates = order ? store.candidateTrucks(order) : [];
  if (!order || candidates.length === 0) {
    emit("toast", "没有可演示的待确认单或可用车，请先建单", "err");
    return;
  }
  armLedgerWriteFailure();
  const res = store.confirmOrder(order, candidates[0].id, order.window);
  emit("toast", `已注入写入故障：${res.error ?? ""}。请到列表从断点恢复`, "err");
}

function sweep() {
  const r = store.sweepExpiredCerts();
  emit(
    "toast",
    `巡检完成：${r.affected} 单未发车占用失效并重算（释放 ${r.freedTons}t），${r.retained} 单已发车保留原依据`,
    r.affected > 0 ? "ok" : "err"
  );
}
</script>

<template>
  <section class="panel">
    <h2>新建配送单</h2>
    <div class="form-grid">
      <label>
        目标油站
        <select v-model="form.station">
          <option>城东站</option>
          <option>机场站</option>
          <option>新区站</option>
        </select>
      </label>
      <label>
        油品
        <select v-model="form.fuel">
          <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
        </select>
      </label>
      <label>
        配送吨数(t)
        <input v-model.number="form.tons" type="number" min="1" step="0.1" />
      </label>
      <label>
        计划到达
        <input v-model="form.arriveAt" type="date" />
      </label>
      <label>
        受理窗口
        <select v-model="form.window">
          <option>窗口1</option>
          <option>窗口2</option>
        </select>
      </label>
      <button type="button" @click="create">保存配送单（待确认）</button>
    </div>

    <hr class="divider" />

    <h2 class="small-h">流程演练</h2>
    <div class="lab">
      <button type="button" class="secondary lab-btn" @click="simulateContention">
        模拟两窗口同时抢同一辆车
      </button>
      <button type="button" class="secondary lab-btn" @click="simulateWriteFailure">
        注入台账写入故障（演示中断恢复）
      </button>
      <button type="button" class="secondary lab-btn warn" @click="sweep">
        巡检司机证件（过期失效重算）
      </button>
      <button type="button" class="secondary lab-btn" @click="store.resetAll()">
        重置演示数据
      </button>
    </div>
    <p class="panel-tip">
      种子车辆 <b>TR-02 豫A·油1002</b> 司机证件已过期（2026-08-15），用于演示：未发车占用失效重算、已发车保留依据。
    </p>
  </section>
</template>
