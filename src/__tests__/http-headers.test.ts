import { describe, expect, test } from 'bun:test'
import { kiroHeaders } from '../plugin/http-headers.js'

describe('the headers every Kiro call carries', () => {
  test('opts out of content retention', () => {
    // Pinned deliberately: this is what tells AWS not to keep what the user
    // wrote. It was missing on the web-search call, which sends the query
    // verbatim.
    expect(kiroHeaders()['x-amzn-codewhisperer-optout']).toBe('true')
  })

  test('names the agent mode the Kiro CLI uses', () => {
    expect(kiroHeaders()['x-amzn-kiro-agent-mode']).toBe('vibe')
  })

  test('carries the profile ARN when there is one', () => {
    const arn = 'arn:aws:codewhisperer:eu-central-1:1:profile/AAA'
    expect(kiroHeaders(arn)['x-amzn-kiro-profile-arn']).toBe(arn)
  })

  test('omits the profile header when there is no ARN', () => {
    expect('x-amzn-kiro-profile-arn' in kiroHeaders()).toBe(false)
  })
})
