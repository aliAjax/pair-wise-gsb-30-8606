// 装车可恢复流程的领域模型：配送单、油罐车占用、地磅回执、审计与 WAL

export type FuelType = "92号汽油" | "95号汽油" | "柴油";

export const FUEL_TYPES: readonly FuelType[] = ["92号汽油", "95号汽油", "柴油"];

export type ReceiptKind = "皮重" | "毛重";

/** 配送单状态：待确认 → 已预占 → 已核销 → 差异待复核 → 已发车；证件失效后未发车回到待重算 */
export type OrderStatus =
  | "待确认"
  | "已预占"
  | "已核销"
  | "差异待复核"
  | "已发车"
  | "待重算";

/** 占用生命周期：预占 → 核销 → 失效（证件过期释放） */
export type OccupationStatus = "预占" | "核销" | "失效";

export type OccupationPhase =
  | "预占罐容"
  | "回执核销"
  | "差异复核放行"
  | "证件失效释放"
  | "发车留存";

export interface Compartment {
  fuel: FuelType;
  capacity: number; // 该油品舱容（吨）
}

export interface Truck {
  id: string;
  plate: string;
  driver: string;
  /** 司机证件到期日，格式 YYYY-MM-DD */
  licenseExpireAt: string;
  compartments: Compartment[];
}

export interface Receipt {
  id: string;
  kind: ReceiptKind;
  actualTons: number; // 回执实际吨数（皮重为自重，毛重为总重；毛重-皮重=净重）
  recordedAt: string;
  /** 核销时为 true；占用失效后回执作废并重置为 false */
  voided: boolean;
}

export interface RecalcMark {
  reason: string;
  at: string;
  releasedTruckId?: string;
  /** 已发车不释放资源，仅保留原依据 */
  basisKept: boolean;
  /** 重算影响范围摘要（占用/差异/回执） */
  scope: string;
}

export interface Occupation {
  id: string;
  orderId: string;
  truckId: string;
  fuel: FuelType;
  /** 确认时按计划吨数预占的罐容（吨） */
  reservedTons: number;
  /** 核销时回执确认的实际净重 */
  actualTons?: number;
  status: OccupationStatus;
  phase: OccupationPhase;
  preallocatedAt: string;
  settledAt?: string;
  releasedAt?: string;
}

export interface Order {
  id: string;
  code: string;
  station: string;
  fuel: FuelType;
  plannedTons: number;
  arriveAt: string;
  status: OrderStatus;
  note: string;
  createdAt: string;
  /** 当前生效占用 id（预占/核销阶段） */
  activeOccupationId?: string;
  /** 已发车后冻结的占用依据 id（不再随证件核查变化） */
  frozenOccupationId?: string;
  /** 计划吨数与回执净重的差异（核销时计算，复核后关闭） */
  diffTons?: number;
  diffReviewed: boolean;
  receipts: Receipt[];
  receiptsExpected: number; // 需要几种回执（皮重+毛重）
  recalc?: RecalcMark;
}

export interface AuditEntry {
  id: string;
  at: string;
  orderId?: string;
  truckId?: string;
  txnId?: string;
  action:
    | "创建配送单"
    | "回执登记"
    | "预占罐容"
    | "窗口竞争失败"
    | "回执到齐核销"
    | "差异生成"
    | "差异复核"
    | "发车"
    | "证件核查重算"
    | "写入中断"
    | "中断恢复"
    | "重置演示数据"
    | "证件到期调整";
  detail: string;
  recovered?: boolean;
  /** 受影响的占用/差异/回执范围 */
  scope?: string;
}

export type TxnKind =
  | "confirm"
  | "settle"
  | "review"
  | "depart"
  | "recalc"
  | "setExpiry";

export interface TxnPayloadMap {
  confirm: { orderId: string; truckId: string; windowName: string };
  settle: { orderId: string };
  review: { orderId: string };
  depart: { orderId: string };
  recalc: { truckIds: string[]; simulatedDate: string };
  setExpiry: { truckId: string; expireAt: string };
}

export interface WalTxn {
  id: string;
  kind: TxnKind;
  payload: TxnPayloadMap[TxnKind];
  windowName: string;
  startedAt: string;
  /** 已完成并落库的步骤（崩溃点之前，恢复时跳过） */
  doneSteps: string[];
  /** 写入失败的断点步骤（恢复时从此步幂等重放） */
  failedStep?: string;
  status: "运行中" | "已完成" | "已中断" | "已拒绝";
  lastError?: string;
}

export interface Database {
  orders: Order[];
  trucks: Truck[];
  occupations: Occupation[];
  audits: AuditEntry[];
  tolerance: number; // 差异复核阈值（吨），阈值内视为一致
  seq: number;
}

export interface PersistedState {
  version: number;
  db: Database;
  wal: WalTxn[];
}

/** 两个窗口并发提交时，只有一单能放行；其余以业务冲突返回 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

/** 写入在指定步骤失败：内存改动已回滚，WAL 记录断点，等待从中断点恢复 */
export class WriteInterrupted extends Error {
  constructor(
    message: string,
    readonly txnId: string,
    readonly failedStep: string,
  ) {
    super(message);
    this.name = "WriteInterrupted";
  }
}
