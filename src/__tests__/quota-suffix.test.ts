import { describe, expect, test } from 'bun:test'
import { applyQuotaSuffix, usageSuffix } from '../plugin/quota-suffix.js'

function mgr(accounts: Array<{ usedCount?: number; limitCount?: number }>): any {
  return { getAccounts: () => accounts }
}

describe('usageSuffix', () => {
  test('formats the percentage of the first account with a known limit', () => {
    expect(usageSuffix(mgr([{ usedCount: 25, limitCount: 100 }]))).toBe('· 25%')
  })

  test('is empty when no account has a limit yet', () => {
    expect(usageSuffix(mgr([{ usedCount: 0, limitCount: 0 }]))).toBe('')
  })
})

describe('applyQuotaSuffix', () => {
  test('appends the suffix to model names on first application', () => {
    const models = { a: { name: 'Claude Sonnet' }, b: { name: 'Claude Opus' } }
    const { changed, suffix } = applyQuotaSuffix(
      models,
      mgr([{ usedCount: 10, limitCount: 100 }]),
      ''
    )
    expect(changed).toBe(true)
    expect(suffix).toBe('· 10%')
    expect(models.a.name).toBe('Claude Sonnet · 10%')
    expect(models.b.name).toBe('Claude Opus · 10%')
  })

  test('replaces the previous suffix rather than stacking a second one', () => {
    const models = { a: { name: 'Claude Sonnet · 10%' } }
    const { changed, suffix } = applyQuotaSuffix(
      models,
      mgr([{ usedCount: 40, limitCount: 100 }]),
      '· 10%'
    )
    expect(changed).toBe(true)
    expect(suffix).toBe('· 40%')
    expect(models.a.name).toBe('Claude Sonnet · 40%')
  })

  test('is a no-op when the suffix is unchanged', () => {
    const models = { a: { name: 'Claude Sonnet · 40%' } }
    const { changed } = applyQuotaSuffix(models, mgr([{ usedCount: 40, limitCount: 100 }]), '· 40%')
    expect(changed).toBe(false)
    expect(models.a.name).toBe('Claude Sonnet · 40%')
  })

  test('is a no-op when no models are registered', () => {
    const { changed, suffix } = applyQuotaSuffix(
      null,
      mgr([{ usedCount: 10, limitCount: 100 }]),
      ''
    )
    expect(changed).toBe(false)
    expect(suffix).toBe('')
  })
})
