import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AppState,
  AuditAction,
  AuditEntry,
  Fuel,
  OccupationLedger,
  Order,
  OrderStatus,
  Receipt,
  Saga,
  SagaStep,
  Truck,
} from "./types";

const STORAGE_KEY = "hxwlfront-19-oil-loading-workflow";

/** 回执到齐口径：每单 1 次皮重 + 1 次毛重 */
const REQUIRED_KINDS: Receipt["kind"][] = ["TARE", "GROSS"];
/** 吨数差异容差（吨），超出必须人工复核 */
export const TOLERANCE_TONS = 0.3;

const seedTrucks: Truck[] = [
  {
    id: "TR-01",
    plate: "豫A·油1001",
    capacity: 20,
    fuels: ["92号汽油", "95号汽油"],
    driver: "张志强",
    certNo: "危驾4101002019",
    certExpireAt: "2027-05-31",
  },
  {
    id: "TR-02",
    plate: "豫A·油1002",
    capacity: 15,
    fuels: ["0号柴油"],
    driver: "李建国",
    certNo: "危驾4101002020",
    // 故意设置为过期，演示“未发车占用失效重算”
    certExpireAt: "2026-08-15",
  },
  {
    id: "TR-03",
    plate: "豫A·油1003",
    capacity: 25,
    fuels: ["92号汽油", "95号汽油", "0号柴油"],
    driver: "王海涛",
    certNo: "危驾4101002021",
    certExpireAt: "2028-02-28",
  },
  {
    id: "TR-04",
    plate: "豫A·油1004",
    capacity: 20,
    fuels: ["0号柴油"],
    driver: "赵永胜",
    certNo: "危驾4101002022",
    certExpireAt: "2027-11-30",
  },
];

function iso(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

const seedState = (): AppState => {
  const orders: Order[] = [
    {
      id: "OD-1001",
      no: "PSD-20260928-01",
      station: "城东站",
      fuel: "92号汽油",
      tons: 18,
      arriveAt: "2026-10-02",
      createdAt: iso(3),
      stage: "DISPATCHED",
      truckId: "TR-01",
      window: "窗口1",
      receipts: [
        { id: "RC-1", orderId: "OD-1001", code: "WB-T-9001", kind: "TARE", weight: 12.4, meteredAt: iso(2) },
        { id: "RC-2", orderId: "OD-1001", code: "WB-G-9001", kind: "GROSS", weight: 30.6, meteredAt: iso(2) },
      ],
      review: {
        net: 18.2,
        planned: 18,
        diff: 0.2,
        tolerance: TOLERANCE_TONS,
        verdict: "APPROVED",
        reviewer: "系统",
        comment: "容差内自动核销",
        reviewedAt: iso(2),
      },
      dispatchedAt: iso(2),
      dispatchedTruckId: "TR-01",
      basisSnapshot: "窗口1 / TR-01 豫A·油1001 / 皮重12.4t 毛重30.6t 净重18.2t",
    },
    {
      id: "OD-1002",
      no: "PSD-20261001-02",
      station: "机场站",
      fuel: "0号柴油",
      tons: 12,
      arriveAt: "2026-10-02",
      createdAt: iso(1),
      stage: "DRAFT",
      window: "窗口2",
      receipts: [],
    },
    {
      id: "OD-1003",
      no: "PSD-20261001-03",
      station: "新区站",
      fuel: "95号汽油",
      tons: 10,
      arriveAt: "2026-10-03",
      createdAt: iso(1),
      stage: "DRAFT",
      window: "窗口1",
      receipts: [],
    },
    {
      id: "OD-1004",
      no: "PSD-20261001-04",
      station: "城东站",
      fuel: "0号柴油",
      tons: 8,
      arriveAt: "2026-10-02",
      createdAt: iso(1),
      stage: "RESERVED",
      truckId: "TR-03",
      window: "窗口1",
      receipts: [],
    },
    {
      // TR-02 未发车：巡检后占用失效并重算
      id: "OD-1005",
      no: "PSD-20261001-05",
      station: "新区站",
      fuel: "0号柴油",
      tons: 12,
      arriveAt: "2026-10-02",
      createdAt: iso(1),
      stage: "RESERVED",
      truckId: "TR-02",
      window: "窗口2",
      receipts: [],
    },
    {
      // TR-02 已发车：巡检后保留原始依据
      id: "OD-1006",
      no: "PSD-20260925-06",
      station: "机场站",
      fuel: "0号柴油",
      tons: 14,
      arriveAt: "2026-09-26",
      createdAt: iso(6),
      stage: "DISPATCHED",
      truckId: "TR-02",
      dispatchedTruckId: "TR-02",
      window: "窗口2",
      receipts: [
        { id: "RC-61", orderId: "OD-1006", code: "WB-T-9006", kind: "TARE", weight: 11.8, meteredAt: iso(5) },
        { id: "RC-62", orderId: "OD-1006", code: "WB-G-9006", kind: "GROSS", weight: 25.9, meteredAt: iso(5) },
      ],
      review: {
        net: 14.1,
        planned: 14,
        diff: 0.1,
        tolerance: TOLERANCE_TONS,
        verdict: "APPROVED",
        reviewer: "系统自动",
        comment: "容差内自动核销",
        reviewedAt: iso(5),
      },
      dispatchedAt: iso(5),
      basisSnapshot: "窗口2 / TR-02 豫A·油1002 / 皮重11.8t 毛重25.9t 净重14.1t",
    },
  ];
  return {
    trucks: seedTrucks,
    orders,
    ledgers: [
      {
        id: "LG-SEED-1004",
        orderId: "OD-1004",
        truckId: "TR-03",
        fuel: "0号柴油",
        tons: 8,
        state: "HELD",
        basis: "窗口1确认 / 配送单 PSD-20261001-04",
        heldAt: iso(1),
      },
      {
        id: "LG-SEED-1005",
        orderId: "OD-1005",
        truckId: "TR-02",
        fuel: "0号柴油",
        tons: 12,
        state: "HELD",
        basis: "窗口2确认 / 配送单 PSD-20261001-05",
        heldAt: iso(1),
      },
    ],
    sagas: [],
    audits: [
      {
        id: crypto.randomUUID(),
        at: iso(5),
        action: "DISPATCHED",
        orderId: "OD-1006",
        truckId: "TR-02",
        window: "窗口2",
        detail: "OD-1006 已发车，依据快照固化",
        scope: "单台车 TR-02",
      },
      {
        id: crypto.randomUUID(),
        at: iso(2),
        action: "DISPATCHED",
        orderId: "OD-1001",
        truckId: "TR-01",
        window: "窗口1",
        detail: "OD-1001 已发车，依据快照固化",
        scope: "单台车 TR-01",
      },
      {
        id: crypto.randomUUID(),
        at: iso(1),
        action: "CONFIRM_COMMITTED",
        orderId: "OD-1004",
        truckId: "TR-03",
        window: "窗口1",
        detail: "预占完成：豫A·油1003 按0号柴油占用 8t，等待地磅回执",
        scope: "车 TR-03（占用后剩 17t）",
      },
      {
        id: crypto.randomUUID(),
        at: iso(1),
        action: "CONFIRM_COMMITTED",
        orderId: "OD-1005",
        truckId: "TR-02",
        window: "窗口2",
        detail: "预占完成：豫A·油1002 按0号柴油占用 12t，等待地磅回执",
        scope: "车 TR-02（占用后剩 3t）",
      },
    ],
    windowClaim: null,
  };
};

function load(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as AppState;
    } catch {
      // 落盘损坏时回落到种子数据
    }
  }
  return seedState();
}

/** 注入式故障：让下一次台账写入失败，演示中断恢复 */
let failNextLedgerWrite = false;
export function armLedgerWriteFailure() {
  failNextLedgerWrite = true;
}

const STEP_ORDER: SagaStep[] = ["CLAIM_WINDOW", "VALIDATE", "PERSIST_LEDGER", "BIND_ORDER", "DONE"];

export const useWorkflowStore = defineStore("loading-workflow", () => {
  const state = ref<AppState>(load());

  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));

  function audit(action: AuditAction, entry: Omit<AuditEntry, "id" | "at" | "action">) {
    state.value.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      ...entry,
    });
    persist();
  }

  // ---------- 派生视图 ----------

  /** 某台车当前仍生效（HELD）的占用 */
  const heldLedgers = computed(() => state.value.ledgers.filter((l) => l.state === "HELD"));

  function heldTons(truckId: string): number {
    return heldLedgers.value
      .filter((l) => l.truckId === truckId)
      .reduce((sum, l) => sum + l.tons, 0);
  }

  function availableTons(truck: Truck): number {
    return Math.max(0, truck.capacity - heldTons(truck.id));
  }

  /** 一辆车一次只能装一种油品：已被某油品占用后，不能再预占其他油品 */
  function truckLockedFuel(truckId: string): Fuel | undefined {
    return heldLedgers.value.find((l) => l.truckId === truckId)?.fuel;
  }

  /** 按油品汇总预占罐容（确认前按油品预占） */
  const fuelOccupation = computed(() => {
    const map = new Map<Fuel, { held: number; byTruck: Record<string, number> }>();
    for (const l of heldLedgers.value) {
      const bucket = map.get(l.fuel) ?? { held: 0, byTruck: {} };
      bucket.held += l.tons;
      bucket.byTruck[l.truckId] = (bucket.byTruck[l.truckId] ?? 0) + l.tons;
      map.set(l.fuel, bucket);
    }
    return map;
  });

  function netTons(order: Order): number | null {
    const tare = order.receipts.find((r) => r.kind === "TARE");
    const gross = order.receipts.find((r) => r.kind === "GROSS");
    if (!tare || !gross) return null;
    return Math.round((gross.weight - tare.weight) * 100) / 100;
  }

  function receiptsComplete(order: Order): boolean {
    return REQUIRED_KINDS.every((kind) => order.receipts.some((r) => r.kind === kind));
  }

  function deriveStatus(order: Order): OrderStatus {
    switch (order.stage) {
      case "DRAFT":
        return "待确认";
      case "RESERVING":
        return "预占中";
      case "RESERVED":
        return "已预占";
      case "RECEIVED":
        return "待核销";
      case "DISPUTED":
        return "差异待复核";
      case "RELEASED":
        return "可发车";
      case "INVALIDATED":
        return "占用失效";
      case "DISPATCHED":
        return "已发车";
    }
  }

  const orders = computed(() =>
    [...state.value.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );

  // ---------- 建单 ----------

  function createOrder(input: {
    station: string;
    fuel: Fuel;
    tons: number;
    arriveAt: string;
    window: string;
  }): Order {
    const order: Order = {
      id: `OD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      no: `PSD-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(
        state.value.orders.length + 1
      ).padStart(2, "0")}`,
      station: input.station,
      fuel: input.fuel,
      tons: input.tons,
      arriveAt: input.arriveAt,
      createdAt: new Date().toISOString(),
      stage: "DRAFT",
      window: input.window,
      receipts: [],
    };
    state.value.orders.push(order);
    audit("ORDER_CREATED", {
      orderId: order.id,
      window: input.window,
      detail: `创建配送单 ${order.no}：${input.station} / ${input.fuel} / ${input.tons}t`,
      scope: "单张配送单",
    });
    return order;
  }

  // ---------- 确认（可恢复 Saga） ----------

  /** 一辆车同时只能服务一张未发车单（两窗口不得抢同一辆车） */
  function truckBoundOrder(truckId: string, excludeOrderId?: string): Order | undefined {
    const active: Order["stage"][] = ["RESERVING", "RESERVED", "RECEIVED", "DISPUTED", "RELEASED"];
    return state.value.orders.find(
      (o) => o.truckId === truckId && o.id !== excludeOrderId && active.includes(o.stage)
    );
  }

  /** 校验一台车能否承接本单 */
  function checkTruck(truck: Truck, fuel: Fuel, tons: number, excludeOrderId?: string): string | null {
    const today = new Date().toISOString().slice(0, 10);
    if (truck.certExpireAt < today) return `司机${truck.driver}证件已过期（${truck.certExpireAt}）`;
    if (!truck.fuels.includes(fuel)) return `该车不允许装载${fuel}`;
    const locked = truckLockedFuel(truck.id);
    if (locked && locked !== fuel) return `该车已预占${locked}，单车不可混装`;
    if (availableTons(truck) < tons) return `剩余罐容不足（剩 ${availableTons(truck)}t / 需 ${tons}t）`;
    const bound = truckBoundOrder(truck.id, excludeOrderId);
    if (bound) return `该车已被配送单 ${bound.no} 占用（${bound.window}确认）`;
    return null;
  }

  function candidateTrucks(order: Order): Truck[] {
    return state.value.trucks.filter((t) => checkTruck(t, order.fuel, order.tons, order.id) === null);
  }

  /**
   * 确认配送单：两窗口同时提交时，窗口确认权（windowClaim）只放行一单。
   * 失败会留下 RESERVING 的 saga，可调用 resumeConfirm 从中断点恢复，
   * 已完成步骤幂等跳过，绝不重复占车。
   */
  function confirmOrder(order: Order, truckId: string, window: string): { ok: boolean; error?: string } {
    if (order.stage === "DISPATCHED") return { ok: false, error: "已发车单据不可重新确认" };
    if (!["DRAFT", "INVALIDATED"].includes(order.stage)) {
      return { ok: false, error: "当前状态不允许确认" };
    }
    // 两窗口互斥：同一时刻只有一个窗口的确认能进入流程
    const claim = state.value.windowClaim;
    if (claim && claim.orderId !== order.id) {
      audit("CONFIRM_REJECTED", {
        orderId: order.id,
        truckId,
        window,
        detail: `${window}提交被拦截：${claim.window}正在确认 ${claim.orderId}，同一时刻只放行一单`,
        scope: "全部待确认窗口",
      });
      return { ok: false, error: `确认权已被${claim.window}占用，请稍后重试` };
    }
    // 入口乐观校验：车辆已被其他未发车单绑定（或证件/罐容不符）直接拒收，不产生中断流程
    const truck = state.value.trucks.find((t) => t.id === truckId);
    if (!truck) return { ok: false, error: "未选中油罐车" };
    const entryProblem = checkTruck(truck, order.fuel, order.tons, order.id);
    if (entryProblem) {
      audit("CONFIRM_REJECTED", {
        orderId: order.id,
        truckId,
        window,
        detail: `${window}提交被拦截：${entryProblem}`,
        scope: `车 ${truckId} 不重复占用`,
      });
      return { ok: false, error: entryProblem };
    }

    const saga: Saga = {
      id: crypto.randomUUID(),
      orderId: order.id,
      truckId,
      tons: order.tons,
      fuel: order.fuel,
      window,
      step: "CLAIM_WINDOW",
      doneSteps: [],
      claimToken: crypto.randomUUID(),
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.value.sagas.push(saga);
    audit("CONFIRM_STARTED", {
      orderId: order.id,
      truckId,
      window,
      detail: `${window}发起确认 ${order.no}，选定 ${truckId}，开始按油品预占罐容`,
      scope: `${order.fuel} / ${order.tons}t / 车 ${truckId}`,
    });
    persist();
    return runSaga(saga.id);
  }

  /** 从最近失败的中断点恢复；每个步骤幂等 */
  function resumeConfirm(sagaId: string): { ok: boolean; error?: string } {
    const saga = state.value.sagas.find((s) => s.id === sagaId);
    if (!saga) return { ok: false, error: "未找到中断流程" };
    if (saga.status === "COMMITTED") return { ok: true };
    audit("CONFIRM_RESUMED", {
      orderId: saga.orderId,
      truckId: saga.truckId,
      window: saga.window,
      detail: `从断点【${saga.step}】恢复，已完成步骤幂等跳过：${saga.doneSteps.join(" → ") || "无"}`,
      scope: `车 ${saga.truckId} / ${saga.fuel} ${saga.tons}t`,
    });
    return runSaga(saga.id);
  }

  /** 中断流程放弃恢复：未写入占用，安全释放窗口确认权 */
  function abortSaga(sagaId: string) {
    const saga = state.value.sagas.find((s) => s.id === sagaId);
    if (!saga || saga.status !== "FAILED") return;
    if (state.value.windowClaim?.token === saga.claimToken) state.value.windowClaim = null;
    const order = state.value.orders.find((o) => o.id === saga.orderId);
    if (order && order.stage === "RESERVING") order.stage = "DRAFT";
    audit("CONFIRM_REJECTED", {
      orderId: saga.orderId,
      truckId: saga.truckId,
      window: saga.window,
      detail: `中断流程已放弃恢复（断点：${saga.failAtStep}），未写入台账，确认权已释放`,
      scope: `车 ${saga.truckId} 可被其他单据选择`,
    });
    persist();
  }

  function markDone(saga: Saga, step: SagaStep) {
    if (!saga.doneSteps.includes(step)) saga.doneSteps.push(step);
    const nextIndex = STEP_ORDER.indexOf(step) + 1;
    saga.step = STEP_ORDER[Math.min(nextIndex, STEP_ORDER.length - 1)];
    saga.updatedAt = new Date().toISOString();
  }

  function runSaga(sagaId: string): { ok: boolean; error?: string } {
    const saga = state.value.sagas.find((s) => s.id === sagaId);
    if (!saga) return { ok: false, error: "流程不存在" };
    const order = state.value.orders.find((o) => o.id === saga.orderId);
    const truck = state.value.trucks.find((t) => t.id === saga.truckId);
    if (!order || !truck) return fail(saga, "单据或车辆数据缺失");

    try {
      // 步骤 1：窗口确认权（幂等：同一 saga 的 token 可重入，其他单据被拒）
      if (!saga.doneSteps.includes("CLAIM_WINDOW")) {
        const claim = state.value.windowClaim;
        if (claim && claim.token !== saga.claimToken) {
          throw new Error(`确认权已被${claim.window}占用`);
        }
        if (!claim) {
          state.value.windowClaim = {
            token: saga.claimToken,
            window: saga.window,
            orderId: order.id,
            at: new Date().toISOString(),
          };
        }
        order.stage = "RESERVING";
        markDone(saga, "CLAIM_WINDOW");
        persist();
      }

      // 步骤 2：业务校验（纯检查无副作用，每次执行/恢复都重新校验：
      // 防止故障等待期间证件过期、罐容变化等导致占用到不合规车辆）
      {
        const problem = checkTruck(truck, saga.fuel, saga.tons, order.id);
        if (problem) throw new Error(problem);
        if (!saga.doneSteps.includes("VALIDATE")) {
          markDone(saga, "VALIDATE");
          persist();
        }
      }

      // 步骤 3：写入占用台账（关键检查点；故障注入在此中断）
      if (!saga.doneSteps.includes("PERSIST_LEDGER")) {
        if (failNextLedgerWrite) {
          failNextLedgerWrite = false;
          throw new Error("台账写入失败（模拟存储故障）");
        }
        const ledger: OccupationLedger = {
          id: `LG-${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
          orderId: order.id,
          truckId: truck.id,
          fuel: saga.fuel,
          tons: saga.tons,
          state: "HELD",
          basis: `${saga.window}确认 / 配送单 ${order.no}`,
          sagaId: saga.id,
          heldAt: new Date().toISOString(),
        };
        state.value.ledgers.push(ledger);
        saga.ledgerId = ledger.id;
        markDone(saga, "PERSIST_LEDGER");
        persist();
      } else if (saga.ledgerId) {
        // 恢复路径：确认台账仍然存在且为 HELD，不重复写入、不重复占车
        const ledger = state.value.ledgers.find((l) => l.id === saga.ledgerId);
        if (!ledger) throw new Error("占用台账丢失，需人工介入");
        if (ledger.state !== "HELD") throw new Error(`台账状态异常：${ledger.state}`);
      }

      // 步骤 4：回写配送单
      if (!saga.doneSteps.includes("BIND_ORDER")) {
        order.truckId = truck.id;
        order.stage = "RESERVED";
        order.invalidReason = undefined;
        order.recalcAt = undefined;
        markDone(saga, "BIND_ORDER");
        persist();
      }

      // 步骤 5：提交，释放窗口确认权
      saga.status = "COMMITTED";
      markDone(saga, "DONE");
      state.value.windowClaim = null;
      persist();
      audit("CONFIRM_COMMITTED", {
        orderId: order.id,
        truckId: truck.id,
        window: saga.window,
        detail: `预占完成：${truck.plate} 按${saga.fuel}占用 ${saga.tons}t，等待地磅回执`,
        scope: `车 ${truck.id}（占用后剩 ${availableTons(truck)}t）`,
      });
      return { ok: true };
    } catch (err) {
      return fail(saga, err instanceof Error ? err.message : String(err));
    }
  }

  function fail(saga: Saga, reason: string): { ok: false; error: string } {
    saga.status = "FAILED";
    saga.failAtStep = saga.step;
    saga.failReason = reason;
    saga.updatedAt = new Date().toISOString();
    persist();
    audit("CONFIRM_FAILED", {
      orderId: saga.orderId,
      truckId: saga.truckId,
      window: saga.window,
      detail: `流程中断于【${saga.step}】：${reason}。占用尚未写入，可从断点恢复`,
      scope: `车 ${saga.truckId}（未产生重复占用）`,
    });
    return { ok: false, error: reason };
  }

  // ---------- 地磅回执与核销 ----------

  function registerReceipt(order: Order, input: Omit<Receipt, "id" | "orderId">) {
    if (order.stage === "DRAFT" || order.stage === "RESERVING") {
      return { ok: false as const, error: "尚未完成预占，不能登记回执" };
    }
    if (order.stage === "DISPATCHED") {
      return { ok: false as const, error: "已发车单据回执已固化" };
    }
    if (!["RESERVED", "RECEIVED", "DISPUTED"].includes(order.stage)) {
      return { ok: false as const, error: "当前状态不能登记回执" };
    }
    const existing = order.receipts.find((r) => r.kind === input.kind);
    const receipt: Receipt = { ...input, id: crypto.randomUUID(), orderId: order.id };
    if (existing) {
      // 地磅改吨数：同类型回执以最新为准，保留审计轨迹
      audit("RECEIPT_REGISTERED", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `${input.code} 改写${input.kind === "TARE" ? "皮重" : "毛重"}：${existing.weight}t → ${input.weight}t`,
        scope: "本单净重与差异将重算",
      });
      order.receipts = order.receipts.filter((r) => r.kind !== input.kind);
      order.review = undefined;
    } else {
      audit("RECEIPT_REGISTERED", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `登记${input.kind === "TARE" ? "皮重" : "毛重"}回执 ${input.code}：${input.weight}t`,
        scope: "本单",
      });
    }
    order.receipts.push(receipt);
    settleReceipts(order);
    persist();
    return { ok: true as const };
  }

  /** 回执到齐后核销；差异超容差挂起复核，未复核不能发车 */
  function settleReceipts(order: Order) {
    if (!receiptsComplete(order) || !["RESERVED", "RECEIVED", "DISPUTED", "RELEASED"].includes(order.stage)) return;
    const net = netTons(order);
    if (net === null) return;
    const diff = Math.round((net - order.tons) * 100) / 100;
    const within = Math.abs(diff) <= TOLERANCE_TONS;
    order.review = {
      net,
      planned: order.tons,
      diff,
      tolerance: TOLERANCE_TONS,
      verdict: "PENDING",
      reviewer: "",
      comment: within ? "容差内，待系统自动核销" : "超出容差，必须人工复核",
    };
    if (within) {
      order.stage = "RELEASED";
      order.review.verdict = "APPROVED";
      order.review.reviewer = "系统自动";
      order.review.reviewedAt = new Date().toISOString();
      order.review.comment = "回执到齐，差异在容差内，自动核销放行";
      // 核销：释放罐容占用（车已装车完成，等待发车）
      releaseLedger(order, "回执核销完成");
      audit("AUTO_WRITEOFF", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `回执到齐净重 ${net}t，差异 ${diff}t 在 ±${TOLERANCE_TONS}t 内，自动核销`,
        scope: `释放 ${order.fuel} ${order.tons}t 预占`,
      });
    } else {
      order.stage = "DISPUTED";
      // 差异未复核前：保留占用，等待复核结论再决定释放/退回
      audit("VARIANCE_FLAGGED", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `净重 ${net}t 与计划 ${order.tons}t 差异 ${diff}t，超出容差 ±${TOLERANCE_TONS}t，挂起复核（禁止发车）`,
        scope: `车 ${order.truckId} 继续占用 ${order.fuel} ${order.tons}t`,
      });
    }
  }

  function releaseLedger(order: Order, reason: string) {
    for (const l of state.value.ledgers) {
      if (l.orderId === order.id && l.state === "HELD") {
        l.state = "RELEASED";
        l.releasedAt = new Date().toISOString();
        l.releasedReason = reason;
      }
    }
  }

  /** 人工复核差异 */
  function reviewVariance(
    order: Order,
    verdict: "APPROVED" | "REJECTED",
    reviewer: string,
    comment: string
  ): { ok: boolean; error?: string } {
    if (order.stage !== "DISPUTED" || !order.review) return { ok: false, error: "该单没有待复核差异" };
    order.review.verdict = verdict;
    order.review.reviewer = reviewer;
    order.review.comment = comment;
    order.review.reviewedAt = new Date().toISOString();
    if (verdict === "APPROVED") {
      order.stage = "RELEASED";
      releaseLedger(order, "差异复核通过后核销");
      audit("VARIANCE_REVIEWED", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `${reviewer} 复核通过差异 ${order.review.diff}t：${comment}，已核销可发车`,
        scope: `释放 ${order.fuel} ${order.tons}t 预占`,
      });
    } else {
      // 驳回差异：退回待补回执，占用保留
      order.stage = "RESERVED";
      audit("VARIANCE_REVIEWED", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `${reviewer} 驳回差异 ${order.review.diff}t：${comment}，退回补正回执，占用保留`,
        scope: `车 ${order.truckId} 保留 ${order.fuel} ${order.tons}t`,
      });
    }
    persist();
    return { ok: true };
  }

  // ---------- 发车 ----------

  function dispatch(order: Order): { ok: boolean; error?: string } {
    if (order.stage === "DISPATCHED") return { ok: false, error: "车辆已在途" };
    if (order.stage === "DISPUTED") {
      audit("DISPATCH_BLOCKED", {
        orderId: order.id,
        truckId: order.truckId,
        window: order.window,
        detail: `拦截发车：吨数差异 ${order.review?.diff}t 尚未复核`,
        scope: "差异未复核的全部单据禁止发车",
      });
      return { ok: false, error: "吨数差异未复核，禁止发车" };
    }
    if (order.stage !== "RELEASED") {
      return { ok: false, error: "回执未核销，不能发车" };
    }
    order.stage = "DISPATCHED";
    order.dispatchedAt = new Date().toISOString();
    order.dispatchedTruckId = order.truckId;
    order.basisSnapshot =
      `${order.window} / ${order.truckId} / ` +
      `净重 ${order.review?.net}t（计划 ${order.tons}t，差异 ${order.review?.diff}t，${order.review?.reviewer}核销）`;
    audit("DISPATCHED", {
      orderId: order.id,
      truckId: order.truckId,
      window: order.window,
      detail: `已发车，原始确认与回执依据固化，后续证件变化不影响本单`,
      scope: `依据快照：${order.basisSnapshot}`,
    });
    persist();
    return { ok: true };
  }

  // ---------- 证件过期：未发车失效重算 / 已发车保留依据 ----------

  /**
   * 扫描证件过期：
   * - 未发车（RESERVED/RECEIVED/DISPUTED/RELEASED/RESERVING）：占用失效并给出重算范围
   * - 已发车：保留原依据，仅在审计中标注
   */
  function sweepExpiredCerts() {
    const today = new Date().toISOString().slice(0, 10);
    const affected: Order[] = [];
    const retained: Order[] = [];
    let freedTons = 0;

    for (const truck of state.value.trucks) {
      if (truck.certExpireAt >= today) continue;
      for (const order of state.value.orders) {
        if (order.truckId !== truck.id && order.dispatchedTruckId !== truck.id) continue;
        if (order.stage === "DISPATCHED") {
          if (order.dispatchedTruckId === truck.id) retained.push(order);
          continue;
        }
        if (["RESERVING", "RESERVED", "RECEIVED", "DISPUTED", "RELEASED"].includes(order.stage)) {
          affected.push(order);
          // 释放该单全部 HELD 占用
          for (const l of state.value.ledgers) {
            if (l.orderId === order.id && l.state === "HELD") {
              l.state = "INVALIDATED";
              l.releasedAt = new Date().toISOString();
              l.releasedReason = `司机${truck.driver}证件${truck.certExpireAt}过期，未发车占用失效`;
              freedTons += l.tons;
            }
          }
          // 中断的 saga 也作废，避免恢复到一台失效车
          for (const saga of state.value.sagas) {
            if (saga.orderId === order.id && saga.status !== "COMMITTED") {
              saga.status = "FAILED";
              saga.failAtStep = saga.step;
              saga.failReason = "车辆证件过期，流程作废";
            }
          }
          if (state.value.windowClaim?.orderId === order.id) state.value.windowClaim = null;
          order.stage = "INVALIDATED";
          order.invalidReason = `司机${truck.driver}证件已过期（${truck.certExpireAt}）`;
          order.recalcAt = new Date().toISOString();
          order.truckId = undefined;
          audit("CERT_INVALIDATED", {
            orderId: order.id,
            truckId: truck.id,
            window: order.window,
            detail: `${order.no} 未发车，${order.invalidReason}，罐容占用失效`,
            scope: `释放 ${order.fuel} 相关占用`,
          });
        }
      }
    }

    for (const order of retained) {
      audit("CERT_INVALIDATED", {
        orderId: order.id,
        truckId: order.dispatchedTruckId,
        window: order.window,
        detail: `${order.no} 已发车，证件过期不影响在途车辆，保留原始依据`,
        scope: `依据快照不变：${order.basisSnapshot}`,
      });
    }

    if (affected.length > 0) {
      const suggestions = affected.map((order) => {
        const alt = state.value.trucks.find((t) => checkTruck(t, order.fuel, order.tons) === null);
        return alt
          ? `${order.no}（${order.fuel} ${order.tons}t）→ 可改派 ${alt.id} ${alt.plate}`
          : `${order.no}（${order.fuel} ${order.tons}t）→ 暂无合规车辆，需调度外协`;
      });
      const scopeText = `受影响单据：${affected.map((o) => o.no).join("、")}；释放罐容合计 ${freedTons}t`;
      const scope = {
        reason: "司机证件过期",
        orderIds: affected.map((o) => o.id),
        freedTons,
        suggestions,
        at: new Date().toISOString(),
      };
      for (const order of affected) order.recalcScope = scope;
      audit("RECALCULATED", {
        window: "系统巡检",
        detail: `占用重算完成：${suggestions.join("；") || "无"}`,
        scope: scopeText,
      });
    }
    persist();
    return { affected: affected.length, retained: retained.length, freedTons };
  }

  /** 占用失效单据的重算建议（列表展示重算范围） */
  function recalcSuggestion(order: Order): string {
    if (order.stage !== "INVALIDATED") return "";
    const alt = state.value.trucks.find((t) => checkTruck(t, order.fuel, order.tons) === null);
    return alt
      ? `可改派 ${alt.id} ${alt.plate}（剩 ${availableTons(alt)}t）`
      : "暂无合规车辆，需调度外协";
  }

  function removeOrder(id: string) {
    state.value.orders = state.value.orders.filter((o) => o.id !== id);
    state.value.ledgers = state.value.ledgers.filter((l) => l.orderId !== id);
    persist();
  }

  function resetAll() {
    state.value = seedState();
    persist();
  }

  return {
    state,
    orders,
    heldLedgers,
    fuelOccupation,
    heldTons,
    availableTons,
    truckLockedFuel,
    netTons,
    receiptsComplete,
    deriveStatus,
    candidateTrucks,
    checkTruck,
    createOrder,
    confirmOrder,
    resumeConfirm,
    abortSaga,
    registerReceipt,
    reviewVariance,
    dispatch,
    sweepExpiredCerts,
    recalcSuggestion,
    removeOrder,
    resetAll,
  };
});
