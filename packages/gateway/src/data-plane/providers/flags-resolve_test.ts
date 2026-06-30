import { test } from 'vitest';

import { resolveEffectiveFlags } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('flags-resolve: no layers → empty set', () => {
  const set = resolveEffectiveFlags([]);
  assertEquals([...set].sort(), []);
});

test('flags-resolve: a layer with a true flag adds it', () => {
  const set = resolveEffectiveFlags([{ 'retry-cyber-policy': true }]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});

test('flags-resolve: a later layer can force-off an earlier true', () => {
  const set = resolveEffectiveFlags([
    { 'retry-cyber-policy': true },
    { 'retry-cyber-policy': false },
  ]);
  assertEquals([...set].sort(), []);
});

test('flags-resolve: a still-later layer can force-on again', () => {
  const set = resolveEffectiveFlags([
    { 'retry-cyber-policy': true },
    { 'retry-cyber-policy': false },
    { 'retry-cyber-policy': true },
  ]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});

test('flags-resolve: upstream layer force-on adds a flag', () => {
  const set = resolveEffectiveFlags([{ 'vendor-deepseek': true }]);
  assertEquals([...set].sort(), ['vendor-deepseek']);
});

test('flags-resolve: model layer force-off wins over upstream force-on', () => {
  const set = resolveEffectiveFlags([
    { 'vendor-deepseek': true },
    { 'vendor-deepseek': false },
  ]);
  assertEquals([...set].sort(), []);
});

test('flags-resolve: later layer wins when both set the same flag', () => {
  const set = resolveEffectiveFlags([
    { 'vendor-qwen': false },
    { 'vendor-qwen': true },
  ]);
  assertEquals([...set].sort(), ['vendor-qwen']);
});

test('flags-resolve: undefined layers are skipped', () => {
  const set = resolveEffectiveFlags([undefined, { 'retry-cyber-policy': true }, undefined]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});

test('flags-resolve: developer/system conversion flags are mutually exclusive', () => {
  const set = resolveEffectiveFlags(
    new Set(['promote-system-to-developer']),
    [{ 'demote-developer-to-system': true }],
  );
  assertEquals([...set].sort(), ['demote-developer-to-system']);
});

test('flags-resolve: promote-system-to-developer disables interleaved system demotion', () => {
  const set = resolveEffectiveFlags(
    new Set(['demote-interleaved-system-to-user']),
    [{ 'promote-system-to-developer': true }],
  );
  assertEquals([...set].sort(), ['promote-system-to-developer']);
});

test('flags-resolve: interleaved system demotion disables promote-system-to-developer', () => {
  const set = resolveEffectiveFlags(
    new Set(['promote-system-to-developer']),
    [{ 'demote-interleaved-system-to-user': true }],
  );
  assertEquals([...set].sort(), ['demote-interleaved-system-to-user']);
});

test('flags-resolve: a later role conversion layer wins over an earlier one', () => {
  const set = resolveEffectiveFlags(
    new Set(),
    [
      { 'promote-system-to-developer': true },
      { 'demote-developer-to-system': true },
      { 'promote-system-to-developer': true },
    ],
  );
  assertEquals([...set].sort(), ['promote-system-to-developer']);
});
