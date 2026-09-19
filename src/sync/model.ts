import type { OkouApiClient } from '../api/client'

interface ModelPreference {
  readonly selectedModel: string | null
  readonly serviceTier: 'priority' | null
  readonly modelSettings?: Readonly<Record<string, { readonly effort?: string }>>
}

interface ModelPolicies {
  readonly workspaceDefaultModel: string | null
  readonly policies: readonly {
    readonly model: string
    readonly isDefault: boolean
    readonly routeStatus: string
    readonly memberEffective?: unknown
  }[]
}

export interface SendModel {
  readonly model: string
  readonly runOptions?: {
    readonly reasoningEffort?: string
    readonly codexServiceTier?: 'fast'
  }
}

// Mirrors CODEX_FAST_MODE_MODELS in the current API contract. Selection itself
// always comes from the member/workspace settings, never a hard-coded model.
const FAST_MODELS = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])

/** Match the web app's personal-default, then workspace-default selection. */
export async function resolveSendModel(
  client: OkouApiClient,
  signal: AbortSignal,
): Promise<SendModel> {
  const [preference, policies] = await Promise.all([
    client.request<ModelPreference>({ path: '/api/user-model-preference', signal }),
    client.request<ModelPolicies>({ path: '/api/model-policies', signal }),
  ])
  signal.throwIfAborted()
  const model = preference.body.selectedModel
    ?? policies.body.policies.find((policy) => policy.isDefault && policy.routeStatus === 'valid')?.model
    ?? policies.body.workspaceDefaultModel
  if (!model) throw new Error('Choose a default model in Okou before starting a new chat')

  const reasoningEffort = preference.body.modelSettings?.[model]?.effort
  const policy = policies.body.policies.find((candidate) => candidate.model === model)
  const fast = preference.body.selectedModel === model
    && preference.body.serviceTier === 'priority'
    && FAST_MODELS.has(model.replace(/^openai\//u, ''))
    && (policy?.memberEffective !== undefined || policy?.routeStatus === 'valid')
  const runOptions = {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fast ? { codexServiceTier: 'fast' as const } : {}),
  }
  return { model, ...(Object.keys(runOptions).length > 0 ? { runOptions } : {}) }
}
