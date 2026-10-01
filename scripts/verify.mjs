// 端到端流程验证：直接在 esbuild 转译后的 store 上跑场景断言
import { build } from "esbuild";
import { createPinia, setActivePinia } from "pinia";
import { mkdirSync } from "node:fs";

mkdirSync("node_modules", { recursive: true });
const outfile = "node_modules/.verify-store.mjs";
await build({
  entryPoints: ["src/store.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  external: ["pinia", "vue", "@vue/*", "vue-demi"],
  logLevel: "silent",
});
const mod = await import("file://" + process.cwd() + "/" + outfile);
const { useWorkflowStore, armLedgerWriteFailure } = mod;

// localStorage shim
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

let pass = 0;
function check(name, cond, extra = "") {
  if (!cond) {
    console.error(`✘ ${name} ${extra}`);
    process.exitCode = 1;
  } else {
    pass++;
    console.log(`✔ ${name} ${extra}`);
  }
}

function freshStore() {
  mem.clear();
  setActivePinia(createPinia());
  return useWorkflowStore();
}

// ---------- 场景 1：两窗口同时抢同一辆车，只放行一单 ----------
{
  const s = freshStore();
  const a = s.createOrder({ station: "城东站", fuel: "92号汽油", tons: 10, arriveAt: "2026-10-03", window: "窗口1" });
  const b = s.createOrder({ station: "机场站", fuel: "92号汽油", tons: 10, arriveAt: "2026-10-03", window: "窗口2" });
  const r1 = s.confirmOrder(a, "TR-01", "窗口1");
  const r2 = s.confirmOrder(b, "TR-01", "窗口2");
  check("1. 第一单确认成功", r1.ok);
  check("2. 第二单被拦截（车辆独占优先）", !r2.ok && /占用|确认权/.test(r2.error), r2.error ?? "");
  check("3. 只有一条 HELD 台账", s.state.ledgers.filter((l) => l.state === "HELD" && l.truckId === "TR-01").length === 1);
  check("4. 窗口确认权已释放", s.state.windowClaim === null);
}

// ---------- 场景 2：写入失败中断，恢复后不重复占车 ----------
{
  const s = freshStore();
  // 先清空 TR-03 上的种子占用，保证写失败场景发生在台账步骤而非入口校验
  const seed1004 = s.state.orders.find((o) => o.id === "OD-1004");
  s.removeOrder(seed1004.id);
  const order = s.state.orders.find((o) => o.stage === "DRAFT"); // OD-1002 柴油12t
  armLedgerWriteFailure();
  const r = s.confirmOrder(order, "TR-03", order.window);
  check("5. 注入故障后确认失败", !r.ok && /台账写入失败/.test(r.error), r.error ?? "");
  const saga = s.state.sagas.find((x) => x.status === "FAILED");
  check("6. 中断点为 PERSIST_LEDGER", !!saga && saga.failAtStep === "PERSIST_LEDGER");
  check("7. 失败时无台账写入", s.state.ledgers.filter((l) => l.orderId === order.id).length === 0);
  check("8. 单据处于预占中", s.deriveStatus(order) === "预占中");
  check("9. 确认权被保留", !!s.state.windowClaim);

  // 其他窗口此时不能提交新单
  const other = s.createOrder({ station: "新区站", fuel: "95号汽油", tons: 5, arriveAt: "2026-10-03", window: "窗口2" });
  const blocked = s.confirmOrder(other, "TR-01", "窗口2");
  check("10. 中断期间其他提交被窗口互斥拦截", !blocked.ok);

  const rr = s.resumeConfirm(saga.id);
  check("11. 恢复成功", rr.ok);
  const ledgers = s.state.ledgers.filter((l) => l.orderId === order.id);
  check("12. 恢复后只有一条台账（不重复占车）", ledgers.length === 1 && ledgers[0].state === "HELD");
  check("13. 恢复后单据已预占", s.deriveStatus(order) === "已预占");
  check("14. 确认权释放", s.state.windowClaim === null);
  check("15. TR-03 占用为本单12t", s.heldTons("TR-03") === 12, `实际 ${s.heldTons("TR-03")}`);

  // 再次恢复幂等
  const again = s.resumeConfirm(saga.id);
  check("16. 重复恢复幂等", again.ok && s.state.ledgers.filter((l) => l.orderId === order.id).length === 1);
}

// ---------- 场景 3：回执到齐核销，差异未复核不能发车 ----------
{
  const s = freshStore();
  const order = s.state.orders.find((o) => o.id === "OD-1004"); // TR-03 柴油 20t
  s.registerReceipt(order, { code: "T1", kind: "TARE", weight: 10, meteredAt: new Date().toISOString() });
  check("17. 仅皮重时仍为已预占", s.deriveStatus(order) === "已预占");
  s.registerReceipt(order, { code: "G1", kind: "GROSS", weight: 18.2, meteredAt: new Date().toISOString() });
  check("18. 净重8.2、差异0.2容差内自动核销", s.deriveStatus(order) === "可发车");
  check("19. 自动核销释放占用", s.state.ledgers.find((l) => l.orderId === "OD-1004").state === "RELEASED");
  const d1 = s.dispatch(order);
  check("20. 核销后可发车", d1.ok && s.deriveStatus(order) === "已发车");

  // 改写毛重制造超差：已发车不允许
  const rewrite = s.registerReceipt(order, { code: "G2", kind: "GROSS", weight: 31.5, meteredAt: new Date().toISOString() });
  check("21. 已发车回执固化不可改写", !rewrite.ok);

  // 另一单制造超差
  const o2 = s.state.orders.find((o) => o.id === "OD-1005");
  s.registerReceipt(o2, { code: "T2", kind: "TARE", weight: 10, meteredAt: new Date().toISOString() });
  s.registerReceipt(o2, { code: "G2", kind: "GROSS", weight: 23, meteredAt: new Date().toISOString() }); // 净重13 差+1
  check("22. 超差挂起差异待复核", s.deriveStatus(o2) === "差异待复核");
  check("23. 差异期间占用保留 HELD", s.state.ledgers.find((l) => l.orderId === "OD-1005").state === "HELD");
  const db = s.dispatch(o2);
  check("24. 差异未复核禁止发车", !db.ok && /未复核/.test(db.error), db.error ?? "");
  s.reviewVariance(o2, "APPROVED", "李主管", "装车超量已确认");
  check("25. 复核通过后可发车", s.deriveStatus(o2) === "可发车");
}

// ---------- 场景 4：证件过期：未发车失效重算，已发车保留依据 ----------
{
  const s = freshStore();
  const r = s.sweepExpiredCerts();
  const undeparted = s.state.orders.find((o) => o.id === "OD-1005");
  const departed = s.state.orders.find((o) => o.id === "OD-1006");
  check("26. 巡检识别1单未发车受影响、1单已发车保留", r.affected === 1 && r.retained === 1, JSON.stringify(r));
  check("27. 未发车单占用失效", s.deriveStatus(undeparted) === "占用失效");
  check("28. 未发车单台账 INVALIDATED", s.state.ledgers.find((l) => l.orderId === "OD-1005").state === "INVALIDATED");
  check("29. 释放罐容 12t", r.freedTons === 12, String(r.freedTons));
  check("30. 重算范围写入单据", !!undeparted.recalcScope && undeparted.recalcScope.orderIds.includes("OD-1005"));
  check("31. 失效单有改派建议", /TR-04/.test(s.recalcSuggestion(undeparted)), s.recalcSuggestion(undeparted));
  check("32. 已发车单状态不变", s.deriveStatus(departed) === "已发车");
  check("33. 已发车依据快照保留", /TR-02/.test(departed.basisSnapshot ?? ""));
  check("34. 失效后可重新选择合规车辆确认", s.candidateTrucks(undeparted).some((t) => t.id === "TR-04"));
  const re = s.confirmOrder(undeparted, "TR-04", "窗口2");
  check("35. 失效单重算后改派 TR-04 重新预占成功", re.ok, re.error ?? "");
}

// ---------- 场景 5：油品互斥（单车不可混装） ----------
{
  const s = freshStore();
  // TR-03 已被 OD-1004 占 0号柴油
  const o = s.createOrder({ station: "新区站", fuel: "92号汽油", tons: 5, arriveAt: "2026-10-03", window: "窗口1" });
  const r = s.confirmOrder(o, "TR-03", "窗口1");
  check("36. 油品不兼容（混装）被拦截", !r.ok && /柴油/.test(r.error ?? ""), r.error ?? "");
}

console.log(`\n${pass} 项断言通过`);
