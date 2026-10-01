import {
  ConflictError,
  FlowError,
  type AuditEntry,
  type Database,
  type Occupation,
  type Order,
  type TxnKind,
  type TxnPayloadMap,
  type WalTxn,
} from "./types";

export interface StepDef<K extends TxnKind = TxnKind> {
  id: string;
  label: string;
  run: (db: Database, ctx: StepCtx<K>) => void;
}

export interface StepCtx<K extends TxnKind> {
  txnId: string;
  payload: TxnPayloadMap[K];
  windowName: string;
  now: string;
}

/** 故障注入点：在某个事务步骤的“写入”时抛错 */
export interface FailurePoint {
  kind: TxnKind;
  stepId: string;
}

function nextId(db: Database, prefix: string): string {
  db.seq += 1;
  return `${prefix}-${db.seq}`;
}

export function findOrder(db: Database, orderId: string): Order {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new FlowError(`配送单不存在：${orderId}`);
  return order;
}

export function findTruck(db: Database, truckId: string) {
  const truck = db.trucks.find((t) => t.id === truckId);
  if (!truck) throw new FlowError(`油罐车不存在：${truckId}`);
  return truck;
}

function activeOccupation(db: Database, order: Order): Occupation | undefined {
  return db.occupations.find((o) => o.id === order.activeOccupationId);
}

/** 未发车的生效占用才算占车；已发车占用只作冻结依据，罐车可再接单 */
function isTruckBusy(db: Database, truckId: string, excludeOrderId?: string): Occupation | undefined {
  return db.occupations.find((o) => {
    if (o.truckId !== truckId || o.status === "失效") return false;
    const owner = db.orders.find((x) => x.id === o.orderId);
    if (!owner || owner.status === "已发车" || owner.activeOccupationId !== o.id) return false;
    return o.orderId !== excludeOrderId;
  });
}

function audit(db: Database, entry: Omit<AuditEntry, "id" | "at"> & { id?: string; at?: string }) {
  const id = entry.id ?? nextId(db, "audit");
  if (db.audits.some((a) => a.id === id)) return; // 恢复重放不重复记审计
  db.audits.unshift({ id, at: entry.at ?? new Date().toISOString(), ...entry });
}

function ensureTruckUsable(db: Database, order: Order, truckId: string, windowName: string) {
  const truck = findTruck(db, truckId);

  // 同一辆罐车在装车窗口内只放行一单（预占记录即并发互斥依据）
  const busy = isTruckBusy(db, truckId, order.id);
  if (busy) {
    const holder = db.orders.find((o) => o.id === busy.orderId);
    throw new ConflictError(
      `油罐车 ${truck.plate} 已被${holder ? `配送单 ${holder.code}` : "另一窗口"}预占，窗口「${windowName}」抢单失败，只放行一单`,
    );
  }

  // 同一配送单只能被确认一次
  const mine = activeOccupation(db, order);
  if (mine && mine.status !== "失效") {
    throw new ConflictError(`配送单 ${order.code} 已完成预占放行，请勿重复占车`);
  }

  const compartment = truck.compartments.find((c) => c.fuel === order.fuel);
  if (!compartment) {
    throw new FlowError(`油罐车 ${truck.plate} 无 ${order.fuel} 舱，不能按该油品预占罐容`);
  }
  if (compartment.capacity < order.plannedTons) {
    throw new FlowError(
      `油罐车 ${truck.plate} 的 ${order.fuel} 舱容 ${compartment.capacity} 吨，小于计划 ${order.plannedTons} 吨`,
    );
  }

  if (truck.licenseExpireAt < new Date().toISOString().slice(0, 10)) {
    throw new FlowError(`司机 ${truck.driver} 证件已于 ${truck.licenseExpireAt} 过期，不能确认装车`);
  }
  return { truck, compartment };
}

const STEP_REGISTRY: { [K in TxnKind]: StepDef<K>[] } = {
  // 确认前按油品预占罐容
  confirm: [
    {
      id: "preallocate",
      label: "按油品预占罐容",
      run(db, ctx) {
        const { orderId, truckId } = ctx.payload as TxnPayloadMap["confirm"];
        const order = findOrder(db, orderId);
        // 先做罐车/单据互斥校验：两窗口同时提交同一单或同一车时给出竞争失败
        const { truck } = ensureTruckUsable(db, order, truckId, ctx.windowName);
        if (!["待确认", "待重算"].includes(order.status)) {
          throw new FlowError(`配送单 ${order.code} 当前为「${order.status}」，不能确认`);
        }

        // 幂等：中断恢复时若占用已落库则直接沿用，不重复占车
        let occ = db.occupations.find(
          (o) => o.orderId === order.id && o.truckId === truckId && o.status !== "失效",
        );
        if (!occ) {
          occ = {
            id: nextId(db, "occ"),
            orderId: order.id,
            truckId: truck.id,
            fuel: order.fuel,
            reservedTons: order.plannedTons,
            status: "预占",
            phase: "预占罐容",
            preallocatedAt: ctx.now,
          };
          db.occupations.push(occ);
        }
        order.activeOccupationId = occ.id;
        order.status = "已预占";
        order.recalc = undefined;
      },
    },
    {
      id: "audit",
      label: "写入确认审计",
      run(db, ctx) {
        const { orderId, truckId, windowName } = ctx.payload as TxnPayloadMap["confirm"];
        const order = findOrder(db, orderId);
        const truck = findTruck(db, truckId);
        const occ = activeOccupation(db, order);
        audit(db, {
          id: `audit-${ctx.txnId}-prealloc`,
          at: ctx.now,
          orderId,
          truckId,
          txnId: ctx.txnId,
          action: "预占罐容",
          detail: `窗口「${windowName}」确认 ${order.code}：${truck.plate} 按 ${order.fuel} 预占 ${order.plannedTons} 吨`,
          scope: `占用 ${occ?.id ?? order.activeOccupationId}；${order.fuel} 舱容量锁定 ${order.plannedTons} 吨`,
        });
      },
    },
  ],

  // 回执到齐后核销
  settle: [
    {
      id: "verify",
      label: "校验皮重/毛重回执到齐",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        const live = order.receipts.filter((r) => !r.voided);
        const tare = live.find((r) => r.kind === "皮重");
        const gross = live.find((r) => r.kind === "毛重");
        if (!tare || !gross) throw new FlowError(`回执未到齐（皮重/毛重），${order.code} 不能核销`);
        const net = gross.actualTons - tare.actualTons;
        if (net <= 0) throw new FlowError(`毛重 ${gross.actualTons} 减皮重 ${tare.actualTons} 净重异常`);
      },
    },
    {
      id: "writeoff",
      label: "核销占用并计算差异",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        const occ = activeOccupation(db, order);
        if (!occ) throw new FlowError(`配送单 ${order.code} 无生效占用，不能核销`);
        if (occ.status === "核销" && ["已核销", "差异待复核", "已发车"].includes(order.status)) return; // 幂等
        if (order.status !== "已预占") throw new FlowError(`配送单 ${order.code} 当前为「${order.status}」，不能核销`);

        const live = order.receipts.filter((r) => !r.voided);
        const tare = live.find((r) => r.kind === "皮重")!;
        const gross = live.find((r) => r.kind === "毛重")!;
        const net = round2(gross.actualTons - tare.actualTons);

        occ.status = "核销";
        occ.phase = "回执核销";
        occ.actualTons = net;
        occ.settledAt = ctx.now;

        order.diffTons = round2(net - order.plannedTons);
        if (Math.abs(order.diffTons) <= db.tolerance) {
          // 容差内视为一致，仍记录差异但无需人工复核
          order.status = "已核销";
          order.diffReviewed = true;
        } else {
          order.status = "差异待复核";
          order.diffReviewed = false;
        }
      },
    },
    {
      id: "audit",
      label: "写入核销与差异审计",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        const occ = activeOccupation(db, order);
        const net = occ?.actualTons;
        audit(db, {
          id: `audit-${ctx.txnId}-settle`,
          at: ctx.now,
          orderId: order.id,
          truckId: occ?.truckId,
          txnId: ctx.txnId,
          action: "回执到齐核销",
          detail: `${order.code} 皮重/毛重回执到齐，净重 ${net} 吨，占用 ${occ?.id} 核销`,
          scope: `占用 ${occ?.id} 预占${occ?.reservedTons}吨→实装${net}吨；回执 2 张核销`,
        });
        if (order.diffTons !== undefined && Math.abs(order.diffTons) > db.tolerance) {
          audit(db, {
            id: `audit-${ctx.txnId}-diff`,
            at: ctx.now,
            orderId: order.id,
            truckId: occ?.truckId,
            txnId: ctx.txnId,
            action: "差异生成",
            detail: `${order.code} 计划 ${order.plannedTons} 吨 / 回执净重 ${net} 吨，差异 ${signed(order.diffTons)} 吨，未复核禁止发车`,
            scope: `差异 ${signed(order.diffTons)} 吨挂起，重算/复核前占用 ${occ?.id} 不释放`,
          });
        }
      },
    },
  ],

  // 差异人工复核
  review: [
    {
      id: "review",
      label: "复核地磅吨数差异",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        if (order.status === "已核销" && order.diffReviewed) return; // 幂等
        if (order.status !== "差异待复核") {
          throw new FlowError(`配送单 ${order.code} 无待复核差异`);
        }
        order.diffReviewed = true;
        order.status = "已核销";
      },
    },
    {
      id: "audit",
      label: "写入复核审计",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        audit(db, {
          id: `audit-${ctx.txnId}-review`,
          at: ctx.now,
          orderId: order.id,
          txnId: ctx.txnId,
          action: "差异复核",
          detail: `${order.code} 差异 ${signed(order.diffTons ?? 0)} 吨已人工复核通过，允许发车`,
          scope: `差异记录关闭；占用 ${order.activeOccupationId} 维持核销`,
        });
      },
    },
  ],

  // 发车：差异未复核不能发车；发车后依据冻结
  depart: [
    {
      id: "gate",
      label: "差异放行校验",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        if (order.status === "已发车") return; // 幂等
        if (order.status !== "已核销" || !order.diffReviewed) {
          throw new FlowError(`配送单 ${order.code} 差异未复核，不能发车`);
        }
        const occ = activeOccupation(db, order);
        if (!occ || occ.status !== "核销") {
          throw new FlowError(`配送单 ${order.code} 占用未核销，不能发车`);
        }
      },
    },
    {
      id: "freeze",
      label: "冻结占用依据并放行",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        if (order.status === "已发车") return;
        const occ = activeOccupation(db, order)!;
        occ.phase = "发车留存";
        order.frozenOccupationId = occ.id;
        order.activeOccupationId = undefined; // 罐车物理释放，可再接单
        order.status = "已发车";
      },
    },
    {
      id: "audit",
      label: "写入发车审计",
      run(db, ctx) {
        const order = findOrder(db, ctx.payload.orderId);
        audit(db, {
          id: `audit-${ctx.txnId}-depart`,
          at: ctx.now,
          orderId: order.id,
          truckId: db.occupations.find((o) => o.id === order.frozenOccupationId)?.truckId,
          txnId: ctx.txnId,
          action: "发车",
          detail: `${order.code} 放行发车，占用依据 ${order.frozenOccupationId}、回执与差异 ${signed(order.diffTons ?? 0)} 吨随单冻结`,
          scope: `占用 ${order.frozenOccupationId} 留存备查；罐车已释放可接新单`,
        });
      },
    },
  ],

  // 证件核查：未发车占用失效重算，已发车保留原依据
  recalc: [
    {
      id: "release",
      label: "失效未发车占用并作废回执",
      run(db, ctx) {
        const { truckIds, simulatedDate } = ctx.payload as TxnPayloadMap["recalc"];
        for (const truckId of truckIds) {
          const truck = findTruck(db, truckId);
          if (truck.licenseExpireAt > simulatedDate) continue;

          for (const occ of db.occupations) {
            if (occ.truckId !== truckId || occ.status === "失效") continue;
            const order = db.orders.find((o) => o.id === occ.orderId);
            if (!order) continue;

            if (order.status === "已发车" || order.frozenOccupationId === occ.id) {
              // 已发车：占用、差异、回执原依据全部保留
              continue;
            }

            const receiptCount = order.receipts.filter((r) => !r.voided).length;
            occ.status = "失效";
            occ.phase = "证件失效释放";
            occ.releasedAt = ctx.now;
            for (const r of order.receipts) r.voided = true;

            order.activeOccupationId = undefined;
            order.status = "待重算";
            const hadDiff = order.diffTons !== undefined && Math.abs(order.diffTons) > db.tolerance;
            order.diffTons = undefined;
            order.diffReviewed = false;
            order.recalc = {
              reason: `司机 ${truck.driver} 证件已于 ${truck.licenseExpireAt} 过期（核查日 ${simulatedDate}）`,
              at: ctx.now,
              releasedTruckId: truck.id,
              basisKept: false,
              scope: `占用 ${occ.id} 失效释放；差异${hadDiff ? "挂起记录清零，" : ""}重算；回执 ${receiptCount} 张作废`,
            };
          }
        }
      },
    },
    {
      id: "audit",
      label: "写入重算范围审计",
      run(db, ctx) {
        const { truckIds, simulatedDate } = ctx.payload as TxnPayloadMap["recalc"];
        for (const truckId of truckIds) {
          const truck = findTruck(db, truckId);
          if (truck.licenseExpireAt > simulatedDate) continue;

          for (const order of db.orders) {
            const occ = db.occupations.find(
              (o) => o.orderId === order.id && o.truckId === truckId,
            );
            if (!occ) continue;

            if (order.status === "已发车" || order.frozenOccupationId === occ.id) {
              audit(db, {
                id: `audit-${ctx.txnId}-keep-${order.id}`,
                at: ctx.now,
                orderId: order.id,
                truckId,
                txnId: ctx.txnId,
                action: "证件核查重算",
                detail: `${truck.plate} 司机证件已过期，但 ${order.code} 已发车，占用 ${occ.id} 与差异依据保留`,
                scope: `已发车：占用/回执/差异原依据全部保留，不重算`,
              });
            } else {
              audit(db, {
                id: `audit-${ctx.txnId}-release-${order.id}`,
                at: ctx.now,
                orderId: order.id,
                truckId,
                txnId: ctx.txnId,
                action: "证件核查重算",
                detail: `${order.code} 因 ${order.recalc?.reason ?? "司机证件过期"} 退回待重算`,
                scope: order.recalc?.scope ?? `占用 ${occ.id} 失效，需重新预占`,
              });
            }
          }
        }
      },
    },
  ],

  // 调整司机证件到期日（用于演示证件过期）
  setExpiry: [
    {
      id: "update",
      label: "更新证件到期日",
      run(db, ctx) {
        const { truckId, expireAt } = ctx.payload as TxnPayloadMap["setExpiry"];
        findTruck(db, truckId).licenseExpireAt = expireAt;
      },
    },
    {
      id: "audit",
      label: "写入证件调整审计",
      run(db, ctx) {
        const { truckId, expireAt } = ctx.payload as TxnPayloadMap["setExpiry"];
        const truck = findTruck(db, truckId);
        audit(db, {
          id: `audit-${ctx.txnId}-expiry`,
          at: ctx.now,
          truckId,
          txnId: ctx.txnId,
          action: "证件到期调整",
          detail: `${truck.plate} 司机 ${truck.driver} 证件到期日调整为 ${expireAt}`,
          scope: `下次证件核查时影响该罐车的占用与重算`,
        });
      },
    },
  ],
};

export function stepsOf(kind: TxnKind): StepDef[] {
  return STEP_REGISTRY[kind] as StepDef[];
}

/** 内存级窗口锁：同一罐车的确认在事务期间互斥（持久化占用记录是最终依据） */
class WindowLockManager {
  private held = new Map<string, string>();

  acquire(keys: string[], txnId: string) {
    for (const key of keys) {
      const owner = this.held.get(key);
      if (owner && owner !== txnId) {
        throw new ConflictError(`资源 ${key} 正被另一窗口事务占用（${owner}），本次提交被拦截`);
      }
    }
    for (const key of keys) this.held.set(key, txnId);
  }

  release(txnId: string) {
    for (const [key, owner] of this.held) if (owner === txnId) this.held.delete(key);
  }
}

export const windowLocks = new WindowLockManager();

export function lockKeysFor(kind: TxnKind, payload: WalTxn["payload"], db: Database): string[] {
  if (kind === "confirm") {
    const p = payload as TxnPayloadMap["confirm"];
    return [`truck:${p.truckId}`, `order:${p.orderId}`];
  }
  if (kind === "recalc") {
    return (payload as TxnPayloadMap["recalc"]).truckIds.map((id) => `truck:${id}`);
  }
  if (kind === "setExpiry") return [`truck:${(payload as TxnPayloadMap["setExpiry"]).truckId}`];
  const p = payload as TxnPayloadMap["settle"] | TxnPayloadMap["review"] | TxnPayloadMap["depart"];
  return [`order:${p.orderId}`];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function signed(n: number): string {
  return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}
