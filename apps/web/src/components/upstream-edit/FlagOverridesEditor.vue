<script setup lang="ts">
// Tri-state flag editor: each flag is either Inherit, On, or Off. The
// `inheritedOverrides` prop is what the "Inherit" pill should resolve to when
// the flag has no explicit override at the level being edited — at the
// upstream level that's the flag's defaultFor; at the model level that's the
// upstream's effective value for the flag.

import { watch } from 'vue';
import type { HTMLAttributes } from 'vue';

import type { FlagDef, UpstreamProviderKind } from '../../api/types.ts';
import { cn, OverlayScrollbars } from '@floway-dev/ui';

const overrides = defineModel<Record<string, boolean>>({ required: true });

const props = withDefaults(defineProps<{
  flags: FlagDef[];
  providerKind: UpstreamProviderKind;
  inheritedOverrides?: Record<string, boolean>;
  namePrefix?: string;
  class?: HTMLAttributes['class'];
}>(), {
  inheritedOverrides: () => ({}),
  namePrefix: 'flag',
});

type TriState = 'inherit' | 'on' | 'off';

const CONFLICTING_FLAGS: Record<string, readonly string[]> = {
  'demote-developer-to-system': ['promote-system-to-developer'],
  'demote-interleaved-system-to-user': ['promote-system-to-developer'],
  'promote-system-to-developer': ['demote-developer-to-system', 'demote-interleaved-system-to-user'],
};

const stateFor = (flagId: string): TriState => {
  if (flagId in overrides.value) return overrides.value[flagId] ? 'on' : 'off';
  return 'inherit';
};

const inheritedLabel = (flag: FlagDef): 'on' | 'off' => {
  const inherited = props.inheritedOverrides[flag.id];
  if (typeof inherited === 'boolean') return inherited ? 'on' : 'off';
  return flag.defaultFor.includes(props.providerKind) ? 'on' : 'off';
};

const enableFlag = (effective: Set<string>, flagId: string): void => {
  for (const conflicting of CONFLICTING_FLAGS[flagId] ?? []) effective.delete(conflicting);
  effective.add(flagId);
};

const effectiveFlagsFor = (values: Record<string, boolean>): ReadonlySet<string> => {
  const effective = new Set<string>();
  for (const flag of props.flags) {
    if (inheritedLabel(flag) === 'on') enableFlag(effective, flag.id);
  }
  for (const [flagId, on] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    if (on) enableFlag(effective, flagId);
    else effective.delete(flagId);
  }
  return effective;
};

const withConflictsForcedOff = (values: Record<string, boolean>): Record<string, boolean> => {
  const effective = effectiveFlagsFor(values);
  const copy = { ...values };
  let changed = false;
  for (const flag of props.flags) {
    if (effective.has(flag.id)) continue;
    if (values[flag.id] !== true && inheritedLabel(flag) !== 'on') continue;
    if (copy[flag.id] !== false) {
      copy[flag.id] = false;
      changed = true;
    }
  }
  return changed ? copy : values;
};

const setState = (flag: FlagDef, next: TriState) => {
  const flagId = flag.id;
  const copy = { ...overrides.value };
  if (next === 'inherit') delete copy[flagId];
  else {
    copy[flagId] = next === 'on';
  }
  if (next === 'on' || (next === 'inherit' && inheritedLabel(flag) === 'on')) {
    for (const conflicting of CONFLICTING_FLAGS[flagId] ?? []) copy[conflicting] = false;
  }
  overrides.value = copy;
};

watch([overrides, () => props.providerKind, () => props.inheritedOverrides, () => props.flags], () => {
  const normalized = withConflictsForcedOff(overrides.value);
  if (normalized !== overrides.value) overrides.value = normalized;
}, { immediate: true, deep: true });

const stateLabel = (state: TriState, flag: FlagDef) => {
  if (state === 'inherit') return `Inherit: ${inheritedLabel(flag)}`;
  return state === 'on' ? 'On' : 'Off';
};

const pillClass = (state: TriState, selected: boolean, inheritedTo: 'on' | 'off') => {
  if (!selected) return 'border-white/10 text-gray-500 hover:bg-white/5';
  if (state === 'on') return 'border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald';
  if (state === 'off') return 'border-accent-rose/40 bg-accent-rose/15 text-accent-rose';
  return inheritedTo === 'on'
    ? 'border-accent-cyan/40 bg-accent-cyan/20 text-accent-cyan'
    : 'border-white/20 bg-white/10 text-gray-200';
};
</script>

<template>
  <OverlayScrollbars :class="cn(props.class)" no-tabindex :v-scrollbar-offset="{ x: 2 }">
    <p v-if="props.flags.length === 0" class="text-[11px] text-gray-600">No flags are registered.</p>
    <div v-else class="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))]">
      <div
        v-for="flag in props.flags"
        :key="flag.id"
        class="flex min-w-0 items-start justify-between gap-3 border-t border-white/[0.06] px-1 py-2.5"
      >
        <div class="min-w-0">
          <span class="block break-words text-xs text-white">{{ flag.label || flag.id }}</span>
          <span v-if="flag.description" class="mt-0.5 block text-[11px] text-gray-500">{{ flag.description }}</span>
        </div>
        <fieldset class="flex shrink-0 items-center gap-1 text-[11px]">
          <label
            v-for="state in (['inherit', 'on', 'off'] as TriState[])"
            :key="state"
            class="flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 transition-colors"
            :class="pillClass(state, stateFor(flag.id) === state, inheritedLabel(flag))"
          >
            <input
              type="radio"
              :name="`${namePrefix}-${flag.id}`"
              :checked="stateFor(flag.id) === state"
              class="sr-only"
              @change="setState(flag, state)"
            >
            <span>{{ stateLabel(state, flag) }}</span>
          </label>
        </fieldset>
      </div>
    </div>
  </OverlayScrollbars>
</template>
