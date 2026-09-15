import { describe, expect, test } from 'bun:test'
import {
  EFFORT_LEVELS,
  getEffectiveEffort,
  isEffort,
  resolveEffort,
  supportsEffort,
  supportsXHighEffort
} from '../plugin/effort.js'

describe('effort module', () => {
  describe('supportsEffort', () => {
    test('returns true for supported models', () => {
      expect(supportsEffort('claude-opus-4.8')).toBe(true)
      expect(supportsEffort('claude-opus-4.7')).toBe(true)
      expect(supportsEffort('claude-sonnet-4.6')).toBe(true)
      expect(supportsEffort('claude-sonnet-4.6-1m')).toBe(true)
      expect(supportsEffort('claude-sonnet-5')).toBe(true)
      expect(supportsEffort('claude-sonnet-5-1m')).toBe(true)
      expect(supportsEffort('claude-opus-5')).toBe(true)
    })

    test('returns false for unsupported models', () => {
      expect(supportsEffort('claude-haiku-4.5')).toBe(false)
      expect(supportsEffort('unknown-model')).toBe(false)
    })
  })

  describe('supportsXHighEffort', () => {
    test('returns true for opus 4.7/4.8/5 and sonnet 5', () => {
      expect(supportsXHighEffort('claude-opus-4.8')).toBe(true)
      expect(supportsXHighEffort('claude-opus-4.7')).toBe(true)
      expect(supportsXHighEffort('claude-opus-5')).toBe(true)
      expect(supportsXHighEffort('claude-sonnet-5')).toBe(true)
      expect(supportsXHighEffort('claude-sonnet-5-1m')).toBe(true)
    })

    test('returns false for other models', () => {
      expect(supportsXHighEffort('claude-opus-4.6')).toBe(false)
      expect(supportsXHighEffort('claude-sonnet-4.6')).toBe(false)
      expect(supportsXHighEffort('claude-opus-4.5')).toBe(false)
    })
  })

  describe('resolveEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(resolveEffort('claude-haiku-4.5', 'max')).toBeUndefined()
    })

    test('returns effort as-is for supported levels', () => {
      expect(resolveEffort('claude-opus-4.8', 'low')).toBe('low')
      expect(resolveEffort('claude-opus-4.8', 'max')).toBe('max')
      expect(resolveEffort('claude-opus-4.8', 'xhigh')).toBe('xhigh')
      expect(resolveEffort('claude-opus-5', 'xhigh')).toBe('xhigh')
      expect(resolveEffort('claude-opus-5', 'max')).toBe('max')
    })

    test('clamps xhigh to max for models without xhigh support', () => {
      expect(resolveEffort('claude-sonnet-4.6', 'xhigh')).toBe('max')
      expect(resolveEffort('claude-opus-4.6', 'xhigh')).toBe('max')
    })
  })

  describe('getEffectiveEffort', () => {
    test('returns undefined for a model with no dial', () => {
      expect(getEffectiveEffort('claude-haiku-4.5', true, 'max')).toBeUndefined()
    })

    test('uses the level the request named', () => {
      for (const level of EFFORT_LEVELS) {
        if (level === 'xhigh') continue
        expect(getEffectiveEffort('claude-opus-5', true, level)).toBe(level)
      }
    })

    test('a level applies even when nothing else asked for thinking', () => {
      expect(getEffectiveEffort('claude-opus-4.8', false, 'high')).toBe('high')
    })

    test('returns undefined when nothing asks for anything', () => {
      // Undefined lets Kiro apply its own default; it does not mean off.
      expect(getEffectiveEffort('claude-opus-4.8', false)).toBeUndefined()
    })

    test('clamps a level the model does not have', () => {
      expect(getEffectiveEffort('claude-sonnet-4.6', true, 'xhigh')).toBe('max')
    })
  })
})

describe('reading an effort that OpenCode sends back', () => {
  test('accepts every level Kiro documents', () => {
    for (const level of EFFORT_LEVELS) {
      expect(isEffort(level)).toBe(true)
    }
  })

  test('rejects anything that is not one', () => {
    // A non-level must fall back rather than be passed to the service, which
    // rejects an unknown effort outright.
    for (const value of ['', 'none', 'HIGH', 'extreme', undefined, null, 3]) {
      expect(isEffort(value)).toBe(false)
    }
  })
})
