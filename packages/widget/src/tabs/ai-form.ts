/** Pure helpers of the AI tab (E7.10): labels and the body of a new connection. */

export type ConnectionType = 'api' | 'subscription' | 'local';
export type Provider = 'anthropic' | 'openai-compatible' | 'claude-code';

export interface ConnectionView {
  id: string;
  label: string;
  type: ConnectionType;
  provider: Provider;
  baseUrl: string | null;
  defaultModel: string | null;
  scope: 'shared' | 'personal';
  hasKey: boolean;
  keyHint: string | null;
  lastTest: { model: string; ok: boolean; tools: boolean; at: string } | null;
}

export interface RoleAssignment {
  role: string;
  connectionId: string;
  model: string | null;
}

export const TYPE_LABEL: Record<ConnectionType, string> = {
  api: 'Chiave API',
  subscription: 'Abbonamento',
  local: 'Modello locale',
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  'openai-compatible': 'Compatibile OpenAI',
  'claude-code': 'Claude Code',
};

export const ROLE_LABEL: Record<string, string> = {
  'content-agent': 'agente contenuti',
  'dev-agent': 'agente sviluppatore',
  'ai-review': 'revisore',
  translate: 'traduzioni',
  'alt-text': 'testi alternativi',
};

export interface ConnectionForm {
  type: ConnectionType;
  provider: Provider;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
  scope: 'shared' | 'personal';
}

export const EMPTY_FORM: ConnectionForm = {
  type: 'api',
  provider: 'anthropic',
  label: '',
  baseUrl: '',
  defaultModel: '',
  apiKey: '',
  scope: 'shared',
};

/** Providers each type allows, as the server checks them. */
export function providersFor(type: ConnectionType): Provider[] {
  if (type === 'subscription') return ['claude-code'];
  if (type === 'local') return ['openai-compatible'];
  return ['anthropic', 'openai-compatible'];
}

/** Which fields the form shows for a type and provider. */
export function fieldsFor(form: Pick<ConnectionForm, 'type' | 'provider'>) {
  return {
    baseUrl: form.provider === 'openai-compatible',
    apiKey: form.type !== 'subscription',
    apiKeyRequired: form.type === 'api',
    modelRequired: form.type !== 'subscription',
  };
}

/** Changing the type keeps the other fields but picks a provider the type allows. */
export function withType(form: ConnectionForm, type: ConnectionType): ConnectionForm {
  const providers = providersFor(type);
  return {
    ...form,
    type,
    provider: providers.includes(form.provider) ? form.provider : providers[0]!,
  };
}

/** Body for `POST /ai/connections`: only the fields that apply, trimmed. */
export function connectionInput(form: ConnectionForm): Record<string, unknown> {
  const fields = fieldsFor(form);
  const input: Record<string, unknown> = {
    label: form.label.trim(),
    type: form.type,
    provider: form.provider,
    scope: form.scope,
  };
  if (fields.baseUrl && form.baseUrl.trim()) input.baseUrl = form.baseUrl.trim();
  if (form.defaultModel.trim()) input.defaultModel = form.defaultModel.trim();
  if (fields.apiKey && form.apiKey.trim()) input.apiKey = form.apiKey.trim();
  return input;
}

/** Roles that use a connection. */
export function rolesOf(roles: readonly RoleAssignment[], connectionId: string): string[] {
  return roles.filter((r) => r.connectionId === connectionId).map((r) => r.role);
}

/** The make target that links a user's Claude Code subscription (TECHNICAL §7.4). */
export function connectCommand(username: string): string {
  return `make connect-claude-code user=${username}`;
}
