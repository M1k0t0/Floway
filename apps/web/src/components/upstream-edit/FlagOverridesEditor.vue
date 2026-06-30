<script setup lang="ts">
// Tri-state flag editor: each flag is either Inherit, On, or Off. The
// `inheritedOverrides` prop is what the "Inherit" pill should resolve to when
// the flag has no explicit override at the level being edited — at the
// upstream level that's the provider-side default (`providerDefaults`); at
// the model level that's the upstream's effective value for the flag.

import { computed, watch } from 'vue';
import type { HTMLAttributes } from 'vue';

import type { UpstreamProviderKind } from '../../api/types.ts';
import type { Flag, FlagDefaults, FlagId, FlagOverrides } from '@floway-dev/provider/flags';
import { cn, OverlayScrollbars } from '@floway-dev/ui';

const overrides = defineModel<FlagOverrides>({ required: true });

const props = withDefaults(defineProps<{
  flags: Flag[];
  providerDefaults: FlagDefaults;
  inheritedOverrides?: FlagOverrides;
  providerKind: UpstreamProviderKind;
  namePrefix?: string;
  readOnly?: boolean;
  class?: HTMLAttributes['class'];
}>(), {
  inheritedOverrides: () => ({}),
  namePrefix: 'flag',
  readOnly: false,
});

type TriState = 'inherit' | 'on' | 'off';

const CONFLICTING_FLAGS: Partial<Record<FlagId, readonly FlagId[]>> = {
  'demote-developer-to-system': ['promote-system-to-developer'],
  'demote-interleaved-system-to-user': ['promote-system-to-developer'],
  'promote-system-to-developer': ['demote-developer-to-system', 'demote-interleaved-system-to-user'],
};

const hiddenFlagIds = computed(() => new Set<FlagId>(
  props.providerKind === 'codex' ? ['demote-developer-to-system'] : [],
));

const visibleFlags = computed(() => props.flags.filter(flag => !hiddenFlagIds.value.has(flag.id as FlagId)));

const stateFor = (flagId: string): TriState => {
  const id = flagId as FlagId;
  if (id in overrides.value) return overrides.value[id] ? 'on' : 'off';
  return 'inherit';
};

const inheritedLabel = (flag: Flag): 'on' | 'off' => {
  const id = flag.id as FlagId;
  const inherited = props.inheritedOverrides[id];
  if (typeof inherited === 'boolean') return inherited ? 'on' : 'off';
  return props.providerDefaults[id] ? 'on' : 'off';
};

const enableFlag = (effective: Set<FlagId>, flagId: FlagId): void => {
  for (const conflicting of CONFLICTING_FLAGS[flagId] ?? []) effective.delete(conflicting);
  effective.add(flagId);
};

const effectiveFlagsFor = (values: FlagOverrides): ReadonlySet<FlagId> => {
  const effective = new Set<FlagId>();
  for (const flag of props.flags) {
    const id = flag.id as FlagId;
    if (inheritedLabel(flag) === 'on') enableFlag(effective, id);
  }
  for (const [id, on] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b)) as [FlagId, boolean][]) {
    if (on) enableFlag(effective, id);
    else effective.delete(id);
  }
  return effective;
};

const withConflictsForcedOff = (values: FlagOverrides): FlagOverrides => {
  const effective = effectiveFlagsFor(values);
  const copy = { ...values };
  let changed = false;
  for (const flag of props.flags) {
    const id = flag.id as FlagId;
    if (effective.has(id)) continue;
    if (values[id] !== true && inheritedLabel(flag) !== 'on') continue;
    if (copy[id] !== false) {
      copy[id] = false;
      changed = true;
    }
  }
  return changed ? copy : values;
};

const withHiddenOverridesScrubbed = (values: FlagOverrides): FlagOverrides => {
  const hidden = hiddenFlagIds.value;
  if (hidden.size === 0) return values;
  const copy = { ...values };
  let changed = false;
  for (const id of hidden) {
    if (id in copy) {
      delete copy[id];
      changed = true;
    }
  }
  return changed ? copy : values;
};

const normalizeOverrides = (values: FlagOverrides): FlagOverrides =>
  withConflictsForcedOff(withHiddenOverridesScrubbed(values));

const setState = (flag: Flag, next: TriState) => {
  const id = flag.id as FlagId;
  const copy = { ...overrides.value };
  if (next === 'inherit') delete copy[id];
  else copy[id] = next === 'on';
  if (next === 'on' || (next === 'inherit' && inheritedLabel(flag) === 'on')) {
    for (const conflicting of CONFLICTING_FLAGS[id] ?? []) copy[conflicting] = false;
  }
  overrides.value = normalizeOverrides(copy);
};

watch([overrides, () => props.providerKind, () => props.inheritedOverrides, () => props.providerDefaults, () => props.flags], () => {
  const normalized = normalizeOverrides(overrides.value);
  if (normalized !== overrides.value) overrides.value = normalized;
}, { immediate: true, deep: true });

const stateLabel = (state: TriState, flag: Flag) => {
  if (state === 'inherit') return `Inherit: ${inheritedLabel(flag)}`;
  return state === 'on' ? 'On' : 'Off';
};

const pillClass = (state: TriState, selected: boolean, inheritedTo: 'on' | 'off') => {
  if (!selected) return props.readOnly
    ? 'border-white/10 text-gray-600'
    : 'border-white/10 text-gray-500 hover:bg-white/5';
  if (state === 'on') return 'border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald';
  if (state === 'off') return 'border-accent-rose/40 bg-accent-rose/15 text-accent-rose';
  return inheritedTo === 'on'
    ? 'border-accent-cyan/40 bg-accent-cyan/20 text-accent-cyan'
    : 'border-white/20 bg-white/10 text-gray-200';
};
</script>

<template>
  <OverlayScrollbars :class="cn(props.class)" no-tabindex :v-scrollbar-offset="{ x: 2 }">
    <p v-if="visibleFlags.length === 0" class="text-[11px] text-gray-600">No flags are registered.</p>
    <div v-else class="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))]">
      <div
        v-for="flag in visibleFlags"
        :key="flag.id"
        class="flex min-w-0 items-start justify-between gap-3 border-t border-white/[0.06] px-1 py-2.5"
      >
        <div class="min-w-0">
          <span class="block break-words text-xs text-white">{{ flag.label }}</span>
          <span v-if="flag.description" class="mt-0.5 block text-[11px] text-gray-500">{{ flag.description }}</span>
        </div>
        <fieldset class="flex shrink-0 items-center gap-1 text-[11px]" :disabled="readOnly">
          <label
            v-for="state in (['inherit', 'on', 'off'] as TriState[])"
            :key="state"
            class="flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors"
            :class="[pillClass(state, stateFor(flag.id) === state, inheritedLabel(flag)), readOnly ? 'cursor-default' : 'cursor-pointer']"
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
