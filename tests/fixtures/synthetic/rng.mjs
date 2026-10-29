/**
 * Deterministic PRNG helpers for the synthetic evaluation fixtures.
 *
 * The generator must never use `Math.random()` or the wall clock: the same seed
 * must always produce byte-identical fixture files so that scores are
 * comparable across runs and machines.
 *
 * @module tests/fixtures/synthetic/rng
 */

/**
 * FNV-1a 32-bit hash over a UTF-16 string. Used to derive independent PRNG
 * streams from one human-readable seed.
 *
 * @param {string} text
 * @returns {number} unsigned 32-bit integer
 */
export function fnv1a32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Small mulberry32 generator with convenience helpers. Each instance owns one
 * named stream, so adding a new stream never perturbs existing fixtures.
 */
export class Rng {
  /**
   * @param {string} seed
   * @param {string} [stream] logical stream name
   */
  constructor(seed, stream = 'main') {
    this.seed = String(seed)
    this.stream = stream
    this.state = fnv1a32(`${this.seed}::${stream}`) || 0x9e3779b9
  }

  /** @returns {number} uniform float in [0, 1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }

  /**
   * @param {number} min inclusive
   * @param {number} max inclusive
   * @returns {number}
   */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** @param {number} probability @returns {boolean} */
  chance(probability) {
    return this.next() < probability
  }

  /**
   * @template T
   * @param {T[]} items
   * @returns {T}
   */
  pick(items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Rng.pick called with an empty list')
    return items[this.int(0, items.length - 1)]
  }

  /**
   * @template T
   * @param {T[]} items
   * @returns {T[]} a shuffled copy
   */
  shuffle(items) {
    const copy = [...items]
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index)
      const value = copy[index]
      copy[index] = copy[swap]
      copy[swap] = value
    }
    return copy
  }

  /**
   * @param {number} min
   * @param {number} max
   * @param {number} digits
   * @returns {number} rounded decimal in [min, max]
   */
  decimal(min, max, digits) {
    return round(min + this.next() * (max - min), digits)
  }
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
export function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Format a decimal with a fixed number of digits. Every numeric fact in the
 * fixtures is formatted through this helper, so the answer key and the
 * conversation text always agree on the exact rendering.
 *
 * @param {number} value
 * @param {number} digits
 * @returns {string}
 */
export function formatFixed(value, digits) {
  return Number(value).toFixed(digits)
}
