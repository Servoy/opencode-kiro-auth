import { Credential, Integration } from '@opencode/plugin'
import { describe, expect, test } from 'bun:test'
import {
  buildIntegrationMethods,
  buildPlaceholderCredential,
  KIRO_MANAGED_CREDENTIAL_ACCESS,
  type V1AuthMethod
} from '../v2/integration.js'

function fakeV1Method(label: string, onCallback?: () => void): V1AuthMethod {
  return {
    label,
    type: 'oauth',
    prompts: [],
    authorize: async () => ({
      url: 'https://signin.example/device',
      method: 'auto',
      expiresIn: 600,
      callback: async () => {
        onCallback?.()
        return { type: 'success' as const, key: 'tok' }
      }
    })
  }
}

describe('buildIntegrationMethods', () => {
  test('maps each v1 auth method to a v2 method with a stable id and authorize', () => {
    const methods = buildIntegrationMethods('kiro', [
      fakeV1Method('AWS Builder ID / IAM Identity Center')
    ])
    expect(methods).toHaveLength(1)
    expect(methods[0]?.method.id).toBe('kiro-oauth-0')
    expect(methods[0]?.method.type).toBe('oauth')
    expect(methods[0]?.method.label).toContain('Builder ID')
    expect(typeof methods[0]?.authorize).toBe('function')
  })

  test('assigns a distinct id per method by index', () => {
    const methods = buildIntegrationMethods('kiro', [
      fakeV1Method('AWS Builder ID / IAM Identity Center'),
      fakeV1Method('IAM Identity Center with Profile ARN')
    ])
    expect(methods.map((m) => m.method.id)).toEqual(['kiro-oauth-0', 'kiro-oauth-1'])
  })

  test('authorize forwards the v1 url and returns an auto-mode authorization', async () => {
    const methods = buildIntegrationMethods('kiro', [fakeV1Method('Method')])
    const auth = await methods[0]!.authorize({})
    expect(auth.url).toBe('https://signin.example/device')
    expect(auth.mode).toBe('auto')
  })

  test('authorize runs the v1 device-code callback (persists the account)', async () => {
    let ran = false
    const methods = buildIntegrationMethods('kiro', [fakeV1Method('Method', () => (ran = true))])
    const auth = await methods[0]!.authorize({})
    await auth.callback
    expect(ran).toBe(true)
  })

  test('the resolved credential decodes as a real Credential.OAuth with no usable token', async () => {
    const methods = buildIntegrationMethods('kiro', [fakeV1Method('Method')])
    const auth = await methods[0]!.authorize({})
    const resolved = (await auth.callback) as {
      type: string
      methodID: string
      access: string
      refresh: string
      expires: number
    }
    // Validate against the real host schema, not a hand copy.
    const credential = Credential.OAuth.make({
      type: 'oauth',
      methodID: Integration.MethodID.make(resolved.methodID),
      refresh: resolved.refresh,
      access: resolved.access,
      expires: resolved.expires
    })
    expect(credential.access).toBe(KIRO_MANAGED_CREDENTIAL_ACCESS)
    expect(credential.refresh).toBe('')
  })

  test('buildPlaceholderCredential is a self-managed sentinel, not a real token', () => {
    const cred = buildPlaceholderCredential('kiro-oauth-0')
    expect(cred.access).toBe(KIRO_MANAGED_CREDENTIAL_ACCESS)
    expect(cred.refresh).toBe('')
    expect(cred.expires).toBe(0)
  })

  test('returns an empty list when there are no v1 methods', () => {
    expect(buildIntegrationMethods('kiro', [])).toEqual([])
  })
})
