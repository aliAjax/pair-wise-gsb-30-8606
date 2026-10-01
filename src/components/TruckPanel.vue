<script setup lang="ts">
import { computed } from "vue";
import { useFlowStore } from "../workflow/store";

const store = useFlowStore();

const rows = computed(() =>
  store.trucks.map((t) => {
    const orderId = store.truckBusyTruckId(t.id);
    const order = orderId ? store.orders.find((o) => o.id === orderId) : undefined;
    return { truck: t, order, expired: store.truckExpired(t.id) };
  }),
);
</script>

<template>
  <section class="side-panel">
    <h3>油罐车与证件核查</h3>
    <p class="hint">
      核查日
      <input v-model="store.simulatedToday" type="date" class="inline-date" />
      <button type="button" class="mini" @click="store.recalcExpired()">执行证件核查重算</button>
    </p>
    <div class="truck-list">
      <div v-for="row in rows" :key="row.truck.id" class="truck-row" :class="{ expired: row.expired }">
        <div class="truck-main">
          <strong>{{ row.truck.plate }}</strong>
          <span>{{ row.truck.driver }} · 证件至 {{ row.truck.licenseExpireAt }}</span>
          <em v-if="row.expired" class="warn">证件已过期</em>
        </div>
        <div class="cabin">
          <span v-for="c in row.truck.compartments" :key="c.fuel" class="chip">
            {{ c.fuel }} {{ c.capacity }}吨
          </span>
        </div>
        <div class="truck-foot">
          <span v-if="row.order" class="chip">装车占用：{{ row.order.code }}</span>
          <span v-else class="chip dim">装车位空闲</span>
          <button type="button" class="mini danger" @click="store.expireLicense(row.truck.id)">
            模拟证件过期
          </button>
        </div>
      </div>
    </div>
    <p class="hint">
      核查规则：过期罐车的<b>未发车</b>占用失效、回执作废并退回待重算；<b>已发车</b>单保留原占用与差异依据。
    </p>
  </section>
</template>
