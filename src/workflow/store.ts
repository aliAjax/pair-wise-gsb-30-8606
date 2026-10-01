import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import {
  lockKeysFor,
  stepsOf,
  windowLocks,
  type FailurePoint,
  type StepCtx,
} from "./engine";
import { seedDatabase } from "./seed";
import {
  ConflictError,
  type AuditEntry,
  type Database,
  type FuelType,
  type Order,
  type Receipt,
  type TxnKind,
  type TxnPayloadMap,
  type WalTxn,
} from "./types";

const STORAGE_KEY = "hxwlfront-19-oil-flow-v2";

interface PendingRecovery {
  txnId: string;
  kind: TxnKind;
  windowName: string;
  failedStep: string;
  lastError: string;
}

interface SimultaneousResult {
  ok: string[];
  rejected: { windowName: string; message: string }[];
  interrupted?: PendingRecovery;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const useFlowStore = defineStore("oilFlow", () => {
  const db = reactive<Database>(loadDb());
  const wal = ref<WalTxn[]>([]);
  const failurePoint = ref<FailurePoint | null>(null);
  const pendingRecovery = ref<PendingRecovery | null>(null);
  const lastMessage = ref<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const simulatedToday = ref("2026-10-01");

  function loadPersisted(): { db: Database; wal: WalTxn[] } | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { version: number; db: Database; wal: WalTxn[] };
      if (parsed.version !== 2 || !parsed.db) return null;
      return { db: parsed.db, wal: parsed.wal ?? [] };
    } catch {
      return null;
    }
  }

  function loadDb(): Database {
    return loadPersisted()?.db ?? seedDatabase();
  }

  // 初始化：恢复 WAL 与中断点提示
  {
    const persisted = loadPersisted();
    if (persisted) wal.value = persisted.wal;
    const interrupted = wal.value.find((t) => t.status === "已中断");
    if (interrupted && interrupted.lastError) {
      pendingRecovery.value = {
        txnId: doneTxnId(interrupted),
        kind: interrupted.kind,
        windowName: interrupted.windowName,
        failedStep: interrupted.failedStep ?? "未知步骤",
        lastError: interrupted.lastError,
      };
    }
  }

  function doneTxnId(txn: WalTxn): string {
    return txn.id;
  }

  let saveGuard = false;
  function persist() {
    if (saveGuard) return;
    saveGuard = true;
    queueMicrotask(() => {
      saveGuard = false;
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 2, db: JSON.parse(JSON.stringify(db)), wal: wal.value }),
      );
    });
  }

  function notify(type: "success" | "error" | "info", text: string) {
    lastMessage.value = { type, text };
  }

  function nextCode(): string {
    const count = db.orders.length + 1;
    return `PS-20261001-${String(count).padStart(2, "0")}`;
  }

  function nextOrderId(): string {
    db.seq += 1;
    return `order-${db.seq}`;
  }

  // ---------- 查询辅助 ----------

  const orders = computed(() => db.orders);
  const trucks = computed(() => db.trucks);
  const occupations = computed(() => db.occupations);
  const audits = computed(() => db.audits);
  const txns = computed(() => wal.value);

  function occupationOf(order: Order) {
    return db.occupations.find((o) => o.id === order.activeOccupationId)
      ?? db.occupations.find((o) => o.id === order.frozenOccupationId);
  }

  function truckOf(order: Order) {
    const occ = occupationOf(order);
    return occ ? db.trucks.find((t) => t.id === occ.truckId) : undefined;
  }

  function liveReceipts(order: Order): Receipt[] {
    return order.receipts.filter((r) => !r.voided);
  }

  function netTons(order: Order): number | null {
    const tare = liveReceipts(order).find((r) => r.kind === "皮重");
    const gross = liveReceipts(order).find((r) => r.kind === "毛重");
    if (!tare || !gross) return null;
    return Math.round((gross.actualTons - tare.actualTons) * 100) / 100;
  }

  /** 罐车当前是否被未发车单占用 */
  function truckBusyTruckId(truckId: string): string | undefined {
    const occ = db.occupations.find((o) => {
      if (o.truckId !== truckId || o.status === "失效") return false;
      const owner = db.orders.find((x) => x.id === o.orderId);
      return !!owner && owner.status !== "已发车" && owner.activeOccupationId === o.id;
    });
    return occ?.orderId;
  }

  function truckExpired(truckId: string): boolean {
    const truck = db.trucks.find((t) => t.id === truckId);
    return !!truck && truck.licenseExpireAt < simulatedToday.value;
  }

  // ---------- 事务执行（WAL + 断点恢复） ----------

  function runTxn<K extends TxnKind>(
    kind: K,
    payload: TxnPayloadMap[K],
    windowName: string,
    opts: { injectFailure?: boolean; resumeOf?: WalTxn } = {},
  ): { txn: WalTxn; interrupted?: PendingRecovery } {
    let txn: WalTxn;
    if (opts.resumeOf) {
      txn = opts.resumeOf;
      txn.status = "运行中";
      txn.failedStep = undefined;
      txn.lastError = undefined;
    } else {
      db.seq += 1;
      txn = {
        id: `txn-${db.seq}`,
        kind,
        payload: clone(payload),
        windowName,
        startedAt: new Date().toISOString(),
        doneSteps: [],
        status: "运行中",
      };
      windowLocks.acquire(lockKeysFor(kind, payload, db), txn.id);
      wal.value = [txn, ...wal.value].slice(0, 50);
    }
    persist();

    const steps = stepsOf(kind);
    const ctx: StepCtx<K> = {
      txnId: txn.id,
      payload,
      windowName,
      now: new Date().toISOString(),
    };

    let interrupted: PendingRecovery | undefined;
    try {
      for (const step of steps) {
        if (txn.doneSteps.includes(step.id)) continue; // 从中断点恢复：跳过已完成步骤

        const snapshot = clone(db);
        try {
          step.run(db, ctx);
          // 模拟写入在该步骤落库时失败：回滚本步内存改动，仅 WAL 前进到断点
          if (
            opts.injectFailure &&
            failurePoint.value &&
            failurePoint.value.kind === kind &&
            failurePoint.value.stepId === step.id
          ) {
            throw new Error(`模拟写入失败 @ ${step.label}（存储介质故障）`);
          }
        } catch (err) {
          restoreDb(snapshot);
          const isWriteFault =
            err instanceof Error && err.message.startsWith("模拟写入失败");
          if (isWriteFault) {
            txn.failedStep = step.id;
            txn.status = "已中断";
            txn.lastError = err.message;
            pendingRecovery.value = {
              txnId: txn.id,
              kind,
              windowName,
              failedStep: step.id,
              lastError: err.message,
            };
            interrupted = pendingRecovery.value ?? undefined;
            addAudit({
              orderId: "orderId" in payload ? (payload as { orderId?: string }).orderId : undefined,
              truckId: "truckId" in payload ? (payload as { truckId?: string }).truckId : undefined,
              txnId: txn.id,
              action: "写入中断",
              detail: `窗口「${windowName}」事务 ${txn.id} 在「${step.label}」写入中断：${err.message}`,
              scope: `断点=${step.id}；已完成步骤 ${txn.doneSteps.join("、") || "无"}，恢复时跳过已落库步骤、幂等重放断点`,
            });
          } else {
            // 业务拒绝（窗口竞争、容量不足、状态不符）：回滚且不留中断点
            txn.status = "已拒绝";
            txn.lastError = err instanceof Error ? err.message : String(err);
            if (err instanceof ConflictError) {
              addAudit({
                orderId: "orderId" in payload ? (payload as { orderId?: string }).orderId : undefined,
                truckId: "truckId" in payload ? (payload as { truckId?: string }).truckId : undefined,
                txnId: txn.id,
                action: "窗口竞争失败",
                detail: `窗口「${windowName}」对 ${txn.kind} 的提交被拒：${txn.lastError}`,
                scope: "未写入任何占用，失败方可换车重新提交",
              });
            }
          }
          persist();
          windowLocks.release(txn.id);
          throw err;
        }
        txn.doneSteps.push(step.id);
        persist(); // 每步独立落库：崩溃后 WAL 的 doneSteps 即中断点
      }

      txn.status = "已完成";
      pendingRecovery.value = null;
      persist();
      windowLocks.release(txn.id);
      return { txn };
    } catch (err) {
      windowLocks.release(txn.id);
      throw err;
    }
  }

  function restoreDb(snapshot: Database) {
    db.orders.splice(0, db.orders.length, ...snapshot.orders);
    db.trucks.splice(0, db.trucks.length, ...snapshot.trucks);
    db.occupations.splice(0, db.occupations.length, ...snapshot.occupations);
    db.audits.splice(0, db.audits.length, ...snapshot.audits);
    db.tolerance = snapshot.tolerance;
    db.seq = snapshot.seq;
  }

  function addAudit(entry: Omit<AuditEntry, "id" | "at">) {
    db.seq += 1;
    db.audits.unshift({ id: `audit-${db.seq}`, at: new Date().toISOString(), ...entry });
    persist();
  }

  /** 从中断点恢复：已完成步骤跳过，失败步骤幂等重放，不重复占车 */
  function recover() {
    const txn = wal.value.find((t) => t.status === "已中断");
    if (!txn || !pendingRecovery.value) {
      notify("info", "没有待恢复的中断事务");
      return;
    }
    const pending = pendingRecovery.value;
    try {
      runTxn(
        txn.kind,
        clone(txn.payload),
        `${txn.windowName}（断点恢复）`,
        { resumeOf: txn },
      );
      addAudit({
        orderId: "orderId" in txn.payload ? (txn.payload as { orderId?: string }).orderId : undefined,
        truckId: "truckId" in txn.payload ? (txn.payload as { truckId?: string }).truckId : undefined,
        txnId: txn.id,
        action: "中断恢复",
        detail: `事务 ${txn.id} 从中断点「${pending.failedStep}」恢复成功，已完成步骤未重复执行`,
        recovered: true,
        scope: `重放步骤：${pending.failedStep}；占用记录沿用，不重复占车`,
      });
      pendingRecovery.value = null;
      notify("success", `已从中断点「${pending.failedStep}」恢复，占用未重复`);
    } catch (err) {
      notify("error", `恢复失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- 业务动作 ----------

  function createOrder(input: { station: string; fuel: FuelType; plannedTons: number; arriveAt: string; note: string }) {
    if (!input.station || input.plannedTons <= 0) {
      notify("error", "请完整填写油站与配送吨数");
      return;
    }
    const id = nextOrderId();
    const order: Order = {
      id,
      code: nextCode(),
      station: input.station,
      fuel: input.fuel,
      plannedTons: input.plannedTons,
      arriveAt: input.arriveAt,
      status: "待确认",
      note: input.note || "暂无备注",
      createdAt: new Date().toISOString(),
      diffReviewed: false,
      receipts: [],
      receiptsExpected: 2,
    };
    db.orders.unshift(order);
    addAudit({
      orderId: id,
      action: "创建配送单",
      detail: `${order.code} 创建：${input.station} / ${input.fuel} / ${input.plannedTons} 吨`,
      scope: "未预占罐容，等待窗口确认",
    });
    notify("success", `配送单 ${order.code} 已创建，待确认`);
  }

  function confirmOrder(orderId: string, truckId: string, windowName: string) {
    try {
      runTxn("confirm", { orderId, truckId, windowName }, windowName);
      const order = db.orders.find((o) => o.id === orderId)!;
      notify("success", `窗口「${windowName}」放行：${order.code} 已按 ${order.fuel} 预占罐容`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  /** 两个窗口对同一罐车同时提交：只放行一单；若首单写入中断，次单必须等断点恢复，不得抢占 */
  function confirmSimultaneous(orderId: string, truckId: string, injectFailure: boolean): SimultaneousResult {
    const result: SimultaneousResult = { ok: [], rejected: [] };
    const windows = ["装车窗口一", "装车窗口二"];
    const previousPoint = failurePoint.value;
    if (injectFailure) failurePoint.value = { kind: "confirm", stepId: "preallocate" };
    try {
      for (const windowName of windows) {
        if (pendingRecovery.value) {
          result.rejected.push({
            windowName,
            message: `前一窗口事务 ${pendingRecovery.value.txnId} 写入中断、占用归属未定，窗口「${windowName}」等待断点恢复，不得抢车`,
          });
          break;
        }
        try {
          runTxn(
            "confirm",
            { orderId, truckId, windowName },
            windowName,
            { injectFailure: injectFailure && windowName === windows[0] },
          );
          result.ok.push(windowName);
        } catch (err) {
          result.rejected.push({
            windowName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      failurePoint.value = previousPoint; // 演练后还原，避免污染后续单窗口事务
    }
    result.interrupted = pendingRecovery.value ?? undefined;
    if (result.ok.length === 1 && !result.interrupted) {
      notify("success", `并发提交结束：${result.ok[0]} 放行，另一窗口被互斥拒绝`);
    } else if (result.interrupted) {
      notify("error", `首单写入中断（${result.interrupted.failedStep}），次单挂起；恢复后只占用一辆车`);
    }
    return result;
  }

  function registerReceipt(orderId: string, kind: Receipt["kind"], tons: number) {
    const order = db.orders.find((o) => o.id === orderId);
    if (!order) return;
    if (!order.activeOccupationId) {
      notify("error", `配送单 ${order.code} 尚未预占罐容，不能登记地磅回执`);
      return;
    }
    if (kind === "皮重" && !(tons > 0)) {
      notify("error", "皮重必须大于 0");
      return;
    }
    db.seq += 1;
    const receipt: Receipt = {
      id: `rcp-${db.seq}`,
      kind,
      actualTons: tons,
      recordedAt: new Date().toISOString(),
      voided: false,
    };
    // 同一类回执以最新一张为准
    order.receipts = order.receipts.filter((r) => !(r.kind === kind && !r.voided));
    order.receipts.push(receipt);
    addAudit({
      orderId,
      truckId: occupationOf(order)?.truckId,
      action: "回执登记",
      detail: `${order.code} 地磅${kind}回执：${tons} 吨`,
      scope: `回执 ${receipt.id}；待齐 ${liveReceipts(order).length}/2`,
    });
    notify("success", `${kind}回执已登记（${liveReceipts(order).length}/2 到齐）`);
  }

  function settle(orderId: string) {
    try {
      runTxn("settle", { orderId }, "地磅窗口");
      const order = db.orders.find((o) => o.id === orderId)!;
      if (order.status === "差异待复核") {
        notify("error", `已核销，但差异 ${order.diffTons?.toFixed(2)} 吨超过容差 ±${db.tolerance}，未复核禁止发车`);
      } else {
        notify("success", `${order.code} 回执到齐并核销，差异在容差内，可发车`);
      }
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  function reviewDiff(orderId: string) {
    try {
      runTxn("review", { orderId }, "调度复核");
      notify("success", "差异已复核通过，发车门禁解除");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  function depart(orderId: string) {
    try {
      runTxn("depart", { orderId }, "发车门禁");
      notify("success", "已放行发车，占用依据随单冻结");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  /** 证件核查：以 simulatedToday 为核查日，过期罐车的未发车占用失效重算 */
  function recalcExpired() {
    const expiredIds = db.trucks.filter((t) => t.licenseExpireAt < simulatedToday.value).map((t) => t.id);
    if (expiredIds.length === 0) {
      notify("info", "核查日没有证件过期的司机");
      return;
    }
    try {
      runTxn("recalc", { truckIds: expiredIds, simulatedDate: simulatedToday.value }, "证件核查");
      notify("success", `证件核查完成：未发车占用已失效重算，已发车单保留原依据`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  function expireLicense(truckId: string) {
    const truck = db.trucks.find((t) => t.id === truckId);
    if (!truck) return;
    const d = new Date(simulatedToday.value);
    d.setDate(d.getDate() - 1);
    const expireAt = d.toISOString().slice(0, 10);
    try {
      runTxn("setExpiry", { truckId, expireAt }, "证件管理");
      notify("info", `${truck.plate} 证件已置为过期，执行「证件核查」查看失效与重算范围`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  function setFailurePoint(point: FailurePoint | null) {
    failurePoint.value = point;
  }

  function resetAll() {
    const fresh = seedDatabase();
    restoreDb(fresh);
    wal.value = [];
    pendingRecovery.value = null;
    failurePoint.value = null;
    addAudit({ action: "重置演示数据", detail: "演示数据与 WAL 已重置", scope: "全部占用/差异/回执恢复初始状态" });
    notify("success", "演示数据已重置");
  }

  // ---------- 指标 ----------

  const metrics = computed(() => {
    const preallocated = db.occupations.filter(
      (o) => o.status === "预占" && db.orders.some((x) => x.activeOccupationId === o.id),
    ).length;
    const pendingDiff = db.orders.filter((o) => o.status === "差异待复核").length;
    const departed = db.orders.filter((o) => o.status === "已发车").length;
    return {
      orders: db.orders.length,
      preallocated,
      pendingDiff,
      departed,
      recoverable: pendingRecovery.value ? 1 : 0,
    };
  });

  return {
    db,
    wal,
    failurePoint,
    pendingRecovery,
    lastMessage,
    simulatedToday,
    // 查询
    orders,
    trucks,
    occupations,
    audits,
    txns,
    metrics,
    occupationOf,
    truckOf,
    liveReceipts,
    netTons,
    truckBusyTruckId,
    truckExpired,
    // 动作
    createOrder,
    confirmOrder,
    confirmSimultaneous,
    registerReceipt,
    settle,
    reviewDiff,
    depart,
    recalcExpired,
    expireLicense,
    setFailurePoint,
    recover,
    resetAll,
  };
});
