import { describe, expect, test } from 'bun:test'
import { noopToast, type ToastFn } from '../plugin/toast.js'

describe('toast', () => {
  test('noopToast is callable and returns nothing', () => {
    const fn: ToastFn = noopToast
    expect(fn('hello', 'info')).toBeUndefined()
  })

  test('a ToastFn receives message and variant', () => {
    const seen: Array<[string, string]> = []
    const fn: ToastFn = (m, v) => {
      seen.push([m, v])
    }
    fn('msg', 'warning')
    expect(seen).toEqual([['msg', 'warning']])
  })
})
