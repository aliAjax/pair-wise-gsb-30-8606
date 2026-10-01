// 油库装车可恢复流程领域模型

export const FUELS = ["92号汽油", "95号汽油", "0号柴油"] as const;
export type Fuel = (typeof FUELS)[number];

/** 配送单业务状态（由占用/回执/差异状态联合推导） */
export type OrderStatus =
  | "待确认" // DRAFT：尚未按油品预占罐容
  | "预占中" // 流程中断，可从断点恢复
  | "已预占" // RESERVED：罐容与车位均已占用，等待回执
  | "待核销" // 回执到齐，差异在容差内自动核销
  | "差异待复核" // 回执到齐但吨数差异超容差
  | "可发车" // RELEASED：已核销且无未决差异
  | "占用失效" // 司机证件过期且未发车，占用释放，需重算
  | "已发车"; // DISPATCHED：保留原始依据

export type OrderStage =
  | "DRAFT"
  | "RESERVING"
  | "RESERVED"
  | "RECEIVED"
  | "DISPUTED"
  | "RELEASED"
  | "INVALIDATED"
  | "DISPATCHED";

export interface Truck {
  id: string;
  plate: string;
  capacity: number; // 核定罐容（吨）
  fuels: Fuel[]; // 可装油品（单车次只能装一种油品，避免混装）
  driver: string;
  certNo: string;
  certExpireAt: string; // 司机证件到期日
}

export type LedgerState = "HELD" | "RELEASED" | "INVALIDATED";

/** 罐容占用台账：按 车×油品 预占，核销后释放 */
export interface OccupationLedger {
  id: string;
  orderId: string;
  truckId: string;
  fuel: Fuel;
  tons: number;
  state: LedgerState;
  basis: string; // 占用依据：确认窗口/单号
  sagaId?: string;
  heldAt: string;
  releasedAt?: string;
  releasedReason?: string;
}

export interface Receipt {
  id: string;
  orderId: string;
  code: string; // 地磅回执单号
  kind: "TARE" | "GROSS"; // 皮重 / 毛重
  weight: number;
  meteredAt: string;
}

export type VarianceVerdict = "PENDING" | "APPROVED" | "REJECTED";

export interface VarianceReview {
  net: number;
  planned: number;
  diff: number;
  tolerance: number;
  verdict: VarianceVerdict;
  reviewer: string;
  comment: string;
  reviewedAt?: string;
}

export interface RecalcScope {
  reason: string; // 触发原因（证件过期等）
  orderIds: string[]; // 被重算影响的配送单
  freedTons: number; // 释放的罐容
  suggestions: string[]; // 重算后的可行分配
  at: string;
}

export interface Order {
  id: string;
  no: string; // 配送单号
  station: string;
  fuel: Fuel;
  tons: number;
  arriveAt: string;
  createdAt: string;
  stage: OrderStage;
  /** 本次预占选中的油罐车（RESERVING/RESERVED 后存在） */
  truckId?: string;
  /** 预占依据：由哪个窗口确认 */
  window: string;
  receipts: Receipt[];
  review?: VarianceReview;
  /** 已发车后原依据保留标记 */
  dispatchedAt?: string;
  dispatchedTruckId?: string;
  basisSnapshot?: string;
  invalidReason?: string;
  recalcAt?: string;
  /** 占用失效后的重算范围（影响单据、释放罐容、改派建议） */
  recalcScope?: RecalcScope;
}

/** 可恢复流程（Saga）：每一步都是幂等的检查点 */
export type SagaStep =
  | "CLAIM_WINDOW" // 抢占确认窗口（两窗口只放行一单）
  | "VALIDATE" // 校验证件/油品兼容/剩余罐容
  | "PERSIST_LEDGER" // 写入占用台账（可注入失败）
  | "BIND_ORDER" // 回写配送单占用依据
  | "DONE";

export interface Saga {
  id: string;
  orderId: string;
  truckId: string;
  tons: number;
  fuel: Fuel;
  window: string;
  step: SagaStep;
  /** 已完成步骤，用于从中断点恢复而不重复占车 */
  doneSteps: SagaStep[];
  ledgerId?: string;
  claimToken: string;
  status: "RUNNING" | "FAILED" | "COMMITTED";
  failAtStep?: SagaStep;
  failReason?: string;
  startedAt: string;
  updatedAt: string;
}

export type AuditAction =
  | "ORDER_CREATED"
  | "CONFIRM_STARTED"
  | "CONFIRM_REJECTED"
  | "CONFIRM_FAILED"
  | "CONFIRM_RESUMED"
  | "CONFIRM_COMMITTED"
  | "RECEIPT_REGISTERED"
  | "AUTO_WRITEOFF"
  | "VARIANCE_FLAGGED"
  | "VARIANCE_REVIEWED"
  | "DISPATCHED"
  | "DISPATCH_BLOCKED"
  | "CERT_INVALIDATED"
  | "RECALCULATED";

export interface AuditEntry {
  id: string;
  at: string;
  action: AuditAction;
  orderId?: string;
  truckId?: string;
  window: string;
  detail: string;
  /** 本次操作影响/覆盖的范围 */
  scope?: string;
}

export interface AppState {
  trucks: Truck[];
  orders: Order[];
  ledgers: OccupationLedger[];
  sagas: Saga[];
  audits: AuditEntry[];
  windowClaim?: { token: string; window: string; orderId: string; at: string } | null;
}
