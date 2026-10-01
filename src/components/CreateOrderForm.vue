<script setup lang="ts">
import { reactive } from "vue";
import { useFlowStore } from "../workflow/store";
import { FUEL_TYPES, type FuelType } from "../workflow/types";

const store = useFlowStore();
const form = reactive({
  station: "",
  fuel: "92号汽油" as FuelType,
  plannedTons: 10,
  arriveAt: new Date().toISOString().slice(0, 10),
  note: "",
});

function submit() {
  store.createOrder({ ...form });
  form.station = "";
  form.note = "";
}
</script>

<template>
  <section class="side-panel">
    <h3>新建配送单</h3>
    <div class="side-form">
      <label>目标油站
        <input v-model="form.station" placeholder="如 城东站" />
      </label>
      <label>油品
        <select v-model="form.fuel">
          <option v-for="f in FUEL_TYPES" :key="f" :value="f">{{ f }}</option>
        </select>
      </label>
      <label>配送吨数
        <input v-model.number="form.plannedTons" type="number" min="1" step="0.5" />
      </label>
      <label>计划到达
        <input v-model="form.arriveAt" type="date" />
      </label>
      <label>备注
        <textarea v-model="form.note" rows="2" placeholder="选填" />
      </label>
      <button type="button" @click="submit" :disabled="!form.station">保存配送单（待确认）</button>
      <p class="hint">保存后不占罐容，须在装车窗口确认才按油品预占。</p>
    </div>
  </section>
</template>
