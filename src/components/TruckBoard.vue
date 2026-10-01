<script setup lang="ts">
import { computed } from "vue";
import { useWorkflowStore } from "../store";
import type { Fuel, Truck } from "../types";
import { FUELS } from "../types";

const store = useWorkflowStore();

const trucks = computed(() => store.state.trucks);

const today = new Date().toISOString().slice(0, 10);

function isExpired(t: Truck) {
  return t.certExpireAt < today;
}

function boundOrder(t: Truck) {
  return store.state.orders.find(
    (o) => o.truckId === t.id && ["RESERVING", "RESERVED", "RECEIVED", "DISPUTED", "RELEASED"].includes(o.stage)
  );
}

const fuelRows = computed(
  () =>
    FUELS.map((fuel: Fuel) => ({
      fuel,
      capacity: trucks.value
        .filter((t) => t.fuels.includes(fuel))
        .reduce((sum, t) => sum + t.capacity, 0),
      held: store.fuelOccupation.get(fuel)?.held ?? 0,
    }))
);
</script>

<template>
  <section class="panel">
    <h2>油罐车与罐容占用</h2>
    <p class="panel-tip">确认前按油品预占罐容；一辆车同时只服务一张未发车单，核销/失效后释放。</p>
    <div class="fuel-strip">
      <span v-for="row in fuelRows" :key="row.fuel" class="fuel-chip">
        {{ row.fuel }}
        <b>预占 {{ row.held }}t</b>
        / 总核定 {{ row.capacity }}t
      </span>
    </div>
    <div class="truck-list">
      <article v-for="t in trucks" :key="t.id" class="truck" :class="{ expired: isExpired(t) }">
        <header>
          <div>
            <strong>{{ t.plate }}</strong>
            <span class="truck-id">{{ t.id }}</span>
          </div>
          <span
            class="badge"
            :class="isExpired(t) ? 'bad' : boundOrder(t) ? 'busy' : 'ok'"
          >
            {{ isExpired(t) ? "证件过期" : boundOrder(t) ? "占用中" : "空闲" }}
          </span>
        </header>
        <div class="truck-grid">
          <span>核定罐容：<b>{{ t.capacity }}t</b></span>
          <span>已预占：<b>{{ store.heldTons(t.id) }}t</b></span>
          <span>可分配：<b>{{ store.availableTons(t) }}t</b></span>
          <span>油品：{{ t.fuels.join("、") }}</span>
          <span>司机：{{ t.driver }}</span>
          <span :class="{ 'text-danger': isExpired(t) }">
            证件有效期至：{{ t.certExpireAt }}
          </span>
        </div>
        <p v-if="boundOrder(t)" class="truck-bound">
          当前绑定：{{ boundOrder(t)?.no }}（{{ boundOrder(t)?.window }}确认）
        </p>
        <p v-else-if="!isExpired(t)" class="truck-bound muted">未绑定未发车单据</p>
        <p v-else class="truck-bound text-danger">证件已过期，新确认将被拦截</p>
      </article>
    </div>
  </section>
</template>
