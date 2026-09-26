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
  /** Only for subscriptions; `linked` is `null` when the agent-runner did not answer (E8.9). */
  subscription?: { linked: boolean | null };
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

/** What the agent-runner answered about the login of a subscription (E8.9). */
export type SubscriptionState = 'linked' | 'not_linked' | 'unknown';

/** Null for connections that are not subscriptions. */
export function subscriptionState(
  connection: Pick<ConnectionView, 'type' | 'subscription'>,
): SubscriptionState | null {
  if (connection.type !== 'subscription') return null;
  const linked = connection.subscription?.linked;
  return linked === true ? 'linked' : linked === false ? 'not_linked' : 'unknown';
}

export const SUBSCRIPTION_LABEL: Record<SubscriptionState, string> = {
  linked: 'Abbonamento collegato',
  not_linked: 'Abbonamento non collegato',
  unknown: 'Collegamento non verificabile',
};

export const SUBSCRIPTION_TONE: Record<SubscriptionState, string> = {
  linked: 'tone-ok',
  not_linked: 'tone-error',
  unknown: 'tone-off',
};

/** The command that links a user's Claude Code subscription (TECHNICAL §7.4). */
export function connectCommand(username: string): string {
  return `docker compose exec -it agent-runner cms-connect claude-code --user ${username}`;
}
