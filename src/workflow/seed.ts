import type { Database, Order, Truck, Occupation } from "./types";

function isoDays(fromNow: number): string {
  const d = new Date("2026-10-01T08:00:00+08:00");
  d.setDate(d.getDate() + fromNow);
  return d.toISOString();
}

function isoDate(fromToday: number): string {
  const d = new Date("2026-10-01");
  d.setDate(d.getDate() + fromToday);
  return d.toISOString().slice(0, 10);
}

export const TRUCKS: Truck[] = [
  {
    id: "truck-A",
    plate: "京A·油1001",
    driver: "张师傅",
    licenseExpireAt: isoDate(20),
    compartments: [
      { fuel: "92号汽油", capacity: 20 },
      { fuel: "95号汽油", capacity: 8 },
    ],
  },
  {
    id: "truck-B",
    plate: "京A·油1002",
    driver: "李师傅",
    licenseExpireAt: isoDate(2),
    compartments: [
      { fuel: "92号汽油", capacity: 15 },
      { fuel: "柴油", capacity: 15 },
    ],
  },
  {
    id: "truck-C",
    plate: "京A·油1003",
    driver: "王师傅",
    licenseExpireAt: isoDate(-5), // 已过期：占用将失效重算；已发车保留依据
    compartments: [
      { fuel: "柴油", capacity: 25 },
      { fuel: "95号汽油", capacity: 10 },
    ],
  },
];

function order(
  partial: Omit<Order, "id" | "createdAt" | "diffReviewed" | "receipts"> &
    Partial<Pick<Order, "id" | "createdAt" | "diffReviewed" | "receipts">>,
): Order {
  return {
    id: partial.id ?? "",
    createdAt: isoDays(-1),
    diffReviewed: partial.diffReviewed ?? false,
    receipts: partial.receipts ?? [],
    ...partial,
  } as Order;
}

export function seedDatabase(): Database {
  const orders: Order[] = [
    order({
      id: "order-1",
      code: "PS-20261001-01",
      station: "城东站",
      fuel: "92号汽油",
      plannedTons: 18,
      arriveAt: isoDate(0),
      status: "已发车",
      note: "车辆已出库",
      activeOccupationId: undefined,
      frozenOccupationId: "occ-1",
      diffReviewed: true,
      diffTons: 0.2,
      receipts: [
        { id: "rcp-1a", kind: "皮重", actualTons: 12, recordedAt: isoDays(0), voided: false },
        { id: "rcp-1b", kind: "毛重", actualTons: 30.2, recordedAt: isoDays(0), voided: false },
      ],
      receiptsExpected: 2,
    }),
    order({
      id: "order-2",
      code: "PS-20261001-02",
      station: "机场站",
      fuel: "柴油",
      plannedTons: 12,
      arriveAt: isoDate(1),
      status: "已预占",
      note: "等待地磅回执",
      activeOccupationId: "occ-2",
      receiptsExpected: 2,
    }),
    order({
      id: "order-3",
      code: "PS-20261001-03",
      station: "新区站",
      fuel: "92号汽油",
      plannedTons: 9,
      arriveAt: isoDate(1),
      status: "待确认",
      note: "两窗口待确认，可演示抢占；罐车失效后可换车重新预占",
      receiptsExpected: 2,
    }),
    order({
      id: "order-4",
      code: "PS-20261001-04",
      station: "城东站",
      fuel: "柴油",
      plannedTons: 22,
      arriveAt: isoDate(2),
      status: "待确认",
      note: "大车 95 号汽油舱不可用，需选匹配车型",
      receiptsExpected: 2,
    }),
  ];

  const occupations: Occupation[] = [
    {
      id: "occ-1",
      orderId: "order-1",
      truckId: "truck-C",
      fuel: "92号汽油",
      reservedTons: 18,
      actualTons: 18.2,
      status: "核销",
      phase: "发车留存",
      preallocatedAt: isoDays(0),
      settledAt: isoDays(0),
    },
    {
      id: "occ-2",
      orderId: "order-2",
      truckId: "truck-B",
      fuel: "柴油",
      reservedTons: 12,
      status: "预占",
      phase: "预占罐容",
      preallocatedAt: isoDays(0),
    },
  ];

  return {
    orders,
    trucks: TRUCKS.map((t) => ({ ...t, compartments: t.compartments.map((c) => ({ ...c })) })),
    occupations,
    audits: [
      {
        id: "audit-seed-1",
        at: isoDays(0),
        orderId: "order-1",
        truckId: "truck-C",
        action: "发车",
        detail: "PS-20261001-01 已发车，占用与差异依据冻结；王师傅证件今日过期也不影响本单",
        scope: "占用 occ-1 冻结保留；差异 +0.20 吨已复核",
      },
    ],
    tolerance: 0.1,
    seq: 100,
  };
}
