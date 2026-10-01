import { Credential, Integration } from '@opencode/plugin'
import { describe, expect, test } from 'bun:test'
import {
  buildIntegrationMethods,
  buildPlaceholderCredential,
  KIRO_MANAGED_CREDENTIAL_ACCESS,
  type V1AuthMethod
} from '../v2/integration.js'

function fakeV1Method(
  label: string,
  onCallback?: () => void,
  onAuthorize?: (inputs?: Record<string, string>) => void,
  prompts: unknown[] = []
): V1AuthMethod {
  return {
    label,
    type: 'oauth',
    prompts,
    authorize: async (inputs?: Record<string, string>) => {
      onAuthorize?.(inputs)
      return {
        url: 'https://signin.example/device',
        method: 'auto',
        expiresIn: 600,
        callback: async () => {
          onCallback?.()
          return { type: 'success' as const, key: 'tok' }
        }
      }
    }
  }
}

const idcPrompts = [
  { type: 'text', key: 'start_url', message: 'IAM Identity Center Start URL', placeholder: 'x' },
  { type: 'text', key: 'idc_region', message: 'Region', placeholder: 'eu-central-1' }
]

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

  test('surfaces the v1 prompts as a v2 form so the host shows the input fields', () => {
    // The bug: v2 dropped the prompts, so the host asked nothing and jumped
    // straight to the browser with no Start URL / Region / Profile ARN. The
    // device page then fell back to AWS Builder ID and the sign-in failed.
    const methods = buildIntegrationMethods('kiro', [
      fakeV1Method('IAM Identity Center with Profile ARN', undefined, undefined, idcPrompts)
    ])
    const form = methods[0]?.method.form
    expect(form).toBeDefined()
    const keys = (form as Array<{ key: string }>).map((f) => f.key)
    expect(keys).toContain('start_url')
    expect(keys).toContain('idc_region')
  })

  test('a method with no prompts carries no form', () => {
    const methods = buildIntegrationMethods('kiro', [fakeV1Method('Method')])
    expect(methods[0]?.method.form).toBeUndefined()
  })

  test('authorize forwards the host answer to the v1 flow (not an empty object)', async () => {
    // The second half of the bug: even if fields were shown, v2 called
    // m.authorize({}), discarding them. The answer must reach the v1 flow.
    let seen: Record<string, string> | undefined
    const methods = buildIntegrationMethods('kiro', [
      fakeV1Method('Method', undefined, (inputs) => (seen = inputs), idcPrompts)
    ])
    await methods[0]!.authorize({
      start_url: 'https://d-996749b310.awsapps.com/start',
      idc_region: 'eu-central-1'
    })
    expect(seen?.start_url).toBe('https://d-996749b310.awsapps.com/start')
    expect(seen?.idc_region).toBe('eu-central-1')
  })
})
