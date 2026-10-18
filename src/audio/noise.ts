import { clamp } from './core';
import type { Rng } from './rng';

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Pre-rendered, seamlessly looping mono noise shared by every generator. */
export interface NoiseBank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
}

/** All noise buffers are normalised to this RMS so generator gains are comparable across colours. */
export const NOISE_RMS = 0.25;

export function createNoiseBank(ctx: BaseAudioContext, rng: Rng, seconds = 4): NoiseBank {
  return {
    white: renderLoop(ctx, seconds, whiteSource(rng)),
    pink: renderLoop(ctx, seconds, pinkSource(rng)),
    brown: renderLoop(ctx, seconds, brownSource(rng)),
  };
}

function whiteSource(rng: Rng): () => number {
  return () => rng.next() * 2 - 1;
}

/** Paul Kellet's refined pink filter (-3 dB/oct) applied to white noise. */
function pinkSource(rng: Rng): () => number {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  return () => {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out;
  };
}

/** Leaky integrator (-6 dB/oct above ~150 Hz): soft "brown" rumble. */
function brownSource(rng: Rng): () => number {
  let last = 0;
  return () => {
    last = (last + 0.02 * (rng.next() * 2 - 1)) / 1.02;
    return last;
  };
}

/**
 * Render a sample generator into a mono buffer whose end flows seamlessly into its start:
 * the samples generated past the end are equal-power crossfaded over the head of the buffer,
 * so a looping source has no click even for strongly correlated (brown) noise.
 */
export function renderLoop(
  ctx: BaseAudioContext,
  seconds: number,
  gen: () => number,
  sampleRate = ctx.sampleRate,
  rms = NOISE_RMS,
): AudioBuffer {
  const n = Math.max(256, Math.floor(seconds * sampleRate));
  const fade = Math.min(Math.floor(0.08 * sampleRate), n >> 2);
  const buffer = ctx.createBuffer(1, n, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = gen();
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    data[i] = data[i]! * Math.sqrt(a) + gen() * Math.sqrt(1 - a);
  }
  if (rms > 0) normalizeRms(data, rms);
  return buffer;
}

/** Remove DC and scale to the target RMS (hard-limited to ±1). */
export function normalizeRms(data: Float32Array, target: number): void {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i]!;
  mean /= data.length;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]! - mean;
    data[i] = v;
    sum += v * v;
  }
  const k = target / (Math.sqrt(sum / data.length) || 1);
  for (let i = 0; i < data.length; i++) data[i] = clamp(data[i]! * k, -1, 1);
}

/** Scale so the absolute peak equals `target`. */
export function normalizePeak(data: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
  if (peak <= 0) return;
  const k = target / peak;
  for (let i = 0; i < data.length; i++) data[i] = data[i]! * k;
}

/** Start a looping noise source at a random offset (caller owns stop/disconnect). */
export function loopNoise(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  rng: Rng,
  when: number,
  playbackRate = 1,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = playbackRate;
  src.start(when, rng.range(0, buffer.duration));
  return src;
}

/** One-shot noise grain from a random position; stops by itself after `duration`. */
export function noiseBurst(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  rng: Rng,
  when: number,
  duration: number,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const d = Math.min(duration, buffer.duration * 0.9);
  src.start(when, rng.range(0, Math.max(0, buffer.duration - d - 0.01)), d);
  return src;
}

/** Two decorrelated loops of the same buffer merged into one stereo signal. */
export function stereoNoise(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  rng: Rng,
  when: number,
): { output: ChannelMergerNode; sources: AudioBufferSourceNode[] } {
  const merger = ctx.createChannelMerger(2);
  const left = loopNoise(ctx, buffer, rng, when, rng.range(0.97, 1.0));
  const right = loopNoise(ctx, buffer, rng, when, rng.range(1.0, 1.03));
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  return { output: merger, sources: [left, right] };
}
