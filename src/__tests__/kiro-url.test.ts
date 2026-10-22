import { describe, expect, test } from 'bun:test'
import { isKiroHost, resolveKiroUrl } from '../core/request/kiro-url.js'

/**
 * The provider is addressed by URL and another plugin can rewrite that URL
 * before the request leaves the process. Everything here is about telling
 * "this request is ours" apart from "this URL starts with our host", because
 * the second is what the plugin used to check and the first is what it needs.
 */
describe('isKiroHost', () => {
  test('accepts the Kiro inference hosts', () => {
    expect(isKiroHost('q.us-east-1.amazonaws.com')).toBe(true)
    expect(isKiroHost('q.eu-central-1.amazonaws.com')).toBe(true)
    expect(isKiroHost('runtime.us-east-1.kiro.dev')).toBe(true)
  })

  test('ignores a port, which says nothing about the service', () => {
    expect(isKiroHost('q.us-east-1.amazonaws.com:443')).toBe(true)
    expect(isKiroHost('runtime.us-east-1.kiro.dev:8443')).toBe(true)
  })

  test('rejects hosts that only look like Kiro hosts', () => {
    expect(isKiroHost('amazonaws.com')).toBe(false)
    expect(isKiroHost('q.us-east-1.amazonaws.com.evil.test')).toBe(false)
    expect(isKiroHost('evil.test')).toBe(false)
    expect(isKiroHost('kiro.dev')).toBe(false)
    expect(isKiroHost('')).toBe(false)
  })
})

describe('resolveKiroUrl', () => {
  test('returns a direct Kiro URL unchanged', () => {
    const url = 'https://q.us-east-1.amazonaws.com/chat/completions'
    expect(resolveKiroUrl(url)).toBe(url)
  })

  test('returns a direct Pro URL unchanged', () => {
    const url = 'https://runtime.us-east-1.kiro.dev/v1/chat/completions'
    expect(resolveKiroUrl(url)).toBe(url)
  })

  test('unwraps a URL a proxy rewrote, keeping the upstream it carries', () => {
    const rewritten =
      'http://127.0.0.1:18789/bili/https://q.us-east-1.amazonaws.com/chat/completions'
    expect(resolveKiroUrl(rewritten)).toBe('https://q.us-east-1.amazonaws.com/chat/completions')
  })

  test('unwraps a rewritten URL with a nested proxy path', () => {
    const rewritten =
      'http://127.0.0.1:18789/proxy/responses/https://runtime.us-east-1.kiro.dev/v1/chat/completions'
    expect(resolveKiroUrl(rewritten)).toBe('https://runtime.us-east-1.kiro.dev/v1/chat/completions')
  })

  test('keeps the query string of the rewritten URL with the upstream', () => {
    const rewritten = 'http://127.0.0.1:18789/bili/https://q.us-east-1.amazonaws.com/v1/models?x=1'
    expect(resolveKiroUrl(rewritten)).toBe('https://q.us-east-1.amazonaws.com/v1/models?x=1')
  })

  test('does not treat a URL mentioned in a query string as the target', () => {
    const url = 'http://127.0.0.1:18789/relay?upstream=https://q.us-east-1.amazonaws.com/x'
    expect(resolveKiroUrl(url)).toBe(null)
  })

  test('returns null for a URL that is not aimed at Kiro', () => {
    expect(resolveKiroUrl('https://api.openai.com/v1/chat/completions')).toBe(null)
    expect(resolveKiroUrl('https://opencode.ai/inference/openai/v1/chat/completions')).toBe(null)
    expect(resolveKiroUrl('https://generativelanguage.googleapis.com/v1beta/models')).toBe(null)
  })

  test('returns null for input that is not a URL', () => {
    expect(resolveKiroUrl('')).toBe(null)
    expect(resolveKiroUrl('not a url')).toBe(null)
  })
})
