/**
 * Headers every call to a Kiro service carries.
 *
 * The opt-out matters most: `x-amzn-codewhisperer-optout` tells AWS not to
 * retain the content of a request for service improvement. It belonged on each
 * call that carries what the user wrote, but lived inline on only one of them,
 * so a path added later inherited nothing. Building the set in one place is
 * what keeps that from happening again.
 */
const KIRO_AGENT_MODE = 'vibe'

/** Opt out of content retention. Kiro CLI sets this on every service call. */
const KIRO_OPT_OUT = 'true'

/**
 * Common Kiro headers, including the content-retention opt-out.
 *
 * `profileArn` is sent as a header as well as in the body — the Kiro CLI does
 * both, and the management endpoints read it from the header.
 */
export function kiroHeaders(profileArn?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-amzn-kiro-agent-mode': KIRO_AGENT_MODE,
    'x-amzn-codewhisperer-optout': KIRO_OPT_OUT
  }
  if (profileArn) headers['x-amzn-kiro-profile-arn'] = profileArn
  return headers
}
