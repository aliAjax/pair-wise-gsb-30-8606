// 核心流程冒烟测试（node 直跑）：双窗口竞争、断点恢复、差异门禁、证件重算
import { createPinia, setActivePinia } from "pinia";

// localStorage 桩
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
};
const flush = () => new Promise((r) => setTimeout(r, 0));

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

const { useFlowStore } = await import("../src/workflow/store.ts");
const { stepsOf } = await import("../src/workflow/engine.ts");

setActivePinia(createPinia());
const store = useFlowStore();
await flush();

// ---------- 场景 1：双窗口同时确认同一罐车，只放行一单 ----------
console.log("场景1：双窗口同时提交只放行一单");
{
  const before = store.occupations.length;
  const r = store.confirmSimultaneous("order-3", "truck-A", false);
  check("仅窗口一放行", r.ok.length === 1 && r.ok[0] === "装车窗口一", JSON.stringify(r));
  check("窗口二被互斥拒绝", r.rejected.length === 1 && /预占放行|请勿重复占车|已被/.test(r.rejected[0].message), r.rejected[0]?.message);
  const o3 = store.orders.find((o) => o.id === "order-3");
  check("订单已预占", o3.status === "已预占");
  check("只新增一条占用", store.occupations.length === before + 1);
  check("无中断待恢复", store.pendingRecovery === null);

  // 同一单不能再次确认占车
  store.resetAll();
  await flush();
}

// ---------- 场景 2：写入失败 → 中断点恢复 → 不重复占车 ----------
console.log("场景2：写入失败从中断点恢复，不重复占车");
{
  setActivePinia(createPinia());
  const s = useFlowStore();
  await flush();
  const r = s.confirmSimultaneous("order-3", "truck-A", true);
  check("两窗口均未放行", r.ok.length === 0);
  check("留下中断点 preallocate", r.interrupted?.failedStep === "preallocate");
  check("占用表没有该单生效占用（回滚）", !s.occupations.some((o) => o.orderId === "order-3" && o.status !== "失效"));
  const occCountBefore = s.occupations.length;
  const txnCount = s.txns.length;

  s.recover();
  await flush();
  check("恢复后无待恢复中断", s.pendingRecovery === null);
  const o3 = s.orders.find((o) => o.id === "order-3");
  check("恢复后订单已预占", o3.status === "已预占");
  const mine = s.occupations.filter((o) => o.orderId === "order-3" && o.status !== "失效");
  check("只存在一条占用（不重复占车）", mine.length === 1, `found ${mine.length}`);
  check("恢复复用原事务（无新事务）", s.txns.length === txnCount);
  check("WAL 全部步骤完成", s.txns[0].doneSteps.length === stepsOf("confirm").length && s.txns[0].status === "已完成");
  check("占用数仅 +1", s.occupations.length === occCountBefore + 1);

  s.resetAll();
  await flush();
}

// ---------- 场景 3：回执核销 + 差异未复核不能发车 + 复核后可发车 ----------
console.log("场景3：回执到齐核销，差异未复核禁发车");
{
  setActivePinia(createPinia());
  const s = useFlowStore();
  await flush();
  s.confirmOrder("order-3", "truck-A", "窗口一");
  // 制造超容差差异：计划 9，净重 10.5（毛重 22.5 - 皮重 12）
  s.registerReceipt("order-3", "皮重", 12);
  s.registerReceipt("order-3", "毛重", 22.5);
  s.settle("order-3");
  let o3 = s.orders.find((o) => o.id === "order-3");
  check("核销后差异待复核", o3.status === "差异待复核");
  check("差异为 +1.50", Math.abs((o3.diffTons ?? 0) - 1.5) < 1e-9);
  check("未复核未标记 reviewed", o3.diffReviewed === false);
  s.depart("order-3");
  // 被拒绝事务会回滚快照、替换数组元素，重新读取引用
  o3 = s.orders.find((o) => o.id === "order-3");
  check("差异未复核不能发车", o3.status === "差异待复核");
  s.reviewDiff("order-3");
  o3 = s.orders.find((o) => o.id === "order-3");
  check("复核后为已核销", o3.status === "已核销" && o3.diffReviewed === true);
  s.depart("order-3");
  o3 = s.orders.find((o) => o.id === "order-3");
  check("复核后可发车并冻结依据", o3.status === "已发车" && !!o3.frozenOccupationId && !o3.activeOccupationId);
  check("已发车罐车装车位释放（可接新单）", !s.truckBusyTruckId("truck-A"));

  // 回执未到齐不能核销
  s.resetAll();
  await flush();
  setActivePinia(createPinia());
  const s2 = useFlowStore();
  await flush();
  s2.confirmOrder("order-3", "truck-A", "窗口一");
  s2.registerReceipt("order-3", "皮重", 12);
  s2.settle("order-3");
  const o3b = s2.orders.find((o) => o.id === "order-3");
  check("回执未到齐保持已预占", o3b.status === "已预占");
  s2.resetAll();
  await flush();
}

// ---------- 场景 4：证件过期——未发车失效重算，已发车保留 ----------
console.log("场景4：证件过期重算范围");
{
  setActivePinia(createPinia());
  const s = useFlowStore();
  await flush();
  // order-2 预占在 truck-B；把 B 证件置为过期（核查日前一天）
  s.expireLicense("truck-B");
  s.recalcExpired();
  const o2 = s.orders.find((o) => o.id === "order-2");
  check("未发车单退回待重算", o2.status === "待重算");
  check("未发车单占用失效", s.occupations.find((x) => x.id === "occ-2")?.status === "失效");
  check("重算范围已记录", /占用 occ-2 失效/.test(o2.recalc?.scope ?? ""));

  // order-1 已发车且占用在 truck-C（证件早已过期），应保留原依据
  const o1 = s.orders.find((o) => o.id === "order-1");
  const occ1 = s.occupations.find((x) => x.id === "occ-1");
  check("已发车单保持已发车", o1.status === "已发车");
  check("已发车占用依据保留为核销", occ1?.status === "核销" && o1.frozenOccupationId === "occ-1");
  check("已发车差异依据保留 +0.20", Math.abs((o1.diffTons ?? 0) - 0.2) < 1e-9);
  check("已发车回执保留", o1.receipts.every((r) => !r.voided));

  // 重算后可换车重新预占（truck-A 92舱可，但 order-2 是柴油 → truck-C 柴油25；C也过期 → 无可用柴油车）
  // 将 C 续期后确认 order-2 到 C
  const c = s.trucks.find((t) => t.id === "truck-C");
  c.licenseExpireAt = "2026-12-31";
  s.confirmOrder("order-2", "truck-C", "窗口一");
  check("重算单可换车重新预占（新占用，不复活旧占用）",
    o2.status === "已预占" &&
    !!o2.activeOccupationId && o2.activeOccupationId !== "occ-2" &&
    s.occupations.find((x) => x.id === "occ-2")?.status === "失效");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
