import type { AuditAction, OrderStatus } from "../types";

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const STATUS_META: Record<OrderStatus, { cls: string; text: string }> = {
  待确认: { cls: "st-draft", text: "待确认" },
  预占中: { cls: "st-reserving", text: "预占中（可恢复）" },
  已预占: { cls: "st-reserved", text: "已预占·等回执" },
  待核销: { cls: "st-received", text: "待核销" },
  差异待复核: { cls: "st-disputed", text: "差异待复核·禁发车" },
  可发车: { cls: "st-released", text: "可发车" },
  占用失效: { cls: "st-invalid", text: "占用失效·待重算" },
  已发车: { cls: "st-dispatched", text: "已发车（依据固化）" },
};

export const ACTION_META: Record<AuditAction, { label: string; cls: string }> = {
  ORDER_CREATED: { label: "建单", cls: "au-create" },
  CONFIRM_STARTED: { label: "确认开始", cls: "au-flow" },
  CONFIRM_REJECTED: { label: "确认拦截", cls: "au-block" },
  CONFIRM_FAILED: { label: "写入中断", cls: "au-fail" },
  CONFIRM_RESUMED: { label: "断点恢复", cls: "au-resume" },
  CONFIRM_COMMITTED: { label: "预占提交", cls: "au-commit" },
  RECEIPT_REGISTERED: { label: "回执登记/改写", cls: "au-flow" },
  AUTO_WRITEOFF: { label: "自动核销", cls: "au-commit" },
  VARIANCE_FLAGGED: { label: "差异挂起", cls: "au-fail" },
  VARIANCE_REVIEWED: { label: "差异复核", cls: "au-review" },
  DISPATCHED: { label: "发车", cls: "au-dispatched" },
  DISPATCH_BLOCKED: { label: "发车拦截", cls: "au-block" },
  CERT_INVALIDATED: { label: "证件过期", cls: "au-fail" },
  RECALCULATED: { label: "占用重算", cls: "au-resume" },
};
