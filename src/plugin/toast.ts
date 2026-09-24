export type ToastVariant = 'info' | 'warning' | 'success' | 'error'

/**
 * Host-agnostic toast sink. The v1 branch binds this to `client.tui.showToast`;
 * the v2 branch supplies its own (or the no-op below) so the shared core never
 * reaches into a host-specific client.
 */
export type ToastFn = (message: string, variant: ToastVariant) => void

/** A toast that goes nowhere, used when the host exposes no toast surface. */
export const noopToast: ToastFn = () => {}
