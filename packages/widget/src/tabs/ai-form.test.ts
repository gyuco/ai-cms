import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  SUBSCRIPTION_LABEL,
  connectCommand,
  connectionInput,
  fieldsFor,
  providersFor,
  rolesOf,
  subscriptionState,
  withType,
  type ConnectionType,
} from './ai-form.ts';

describe('AI connection form', () => {
  it('offers the providers each type allows', () => {
    expect(providersFor('api')).toEqual(['anthropic', 'openai-compatible']);
    expect(providersFor('local')).toEqual(['openai-compatible']);
    expect(providersFor('subscription')).toEqual(['claude-code']);
  });

  it('keeps a compatible provider when the type changes', () => {
    const local = withType({ ...EMPTY_FORM, label: 'Ollama' }, 'local');
    expect(local).toMatchObject({ type: 'local', provider: 'openai-compatible', label: 'Ollama' });
    expect(withType(local, 'api').provider).toBe('openai-compatible');
    expect(withType(local, 'subscription').provider).toBe('claude-code');
  });

  it('shows only the fields that apply', () => {
    expect(fieldsFor({ type: 'api', provider: 'anthropic' })).toEqual({
      baseUrl: false,
      apiKey: true,
      apiKeyRequired: true,
      modelRequired: true,
    });
    expect(fieldsFor({ type: 'local', provider: 'openai-compatible' })).toMatchObject({
      baseUrl: true,
      apiKeyRequired: false,
    });
    expect(fieldsFor({ type: 'subscription', provider: 'claude-code' })).toMatchObject({
      apiKey: false,
      modelRequired: false,
    });
  });

  it('builds the request body without the fields of other types', () => {
    expect(
      connectionInput({
        ...EMPTY_FORM,
        label: ' Claude ',
        baseUrl: 'http://ignored',
        defaultModel: ' claude-sonnet-4-5 ',
        apiKey: ' sk-ant-123 ',
      }),
    ).toEqual({
      label: 'Claude',
      type: 'api',
      provider: 'anthropic',
      scope: 'shared',
      defaultModel: 'claude-sonnet-4-5',
      apiKey: 'sk-ant-123',
    });
    expect(
      connectionInput({
        ...withType(EMPTY_FORM, 'subscription'),
        label: 'Il mio Claude',
        apiKey: 'leftover',
      }),
    ).toEqual({
      label: 'Il mio Claude',
      type: 'subscription',
      provider: 'claude-code',
      scope: 'shared',
    });
  });

  it('finds the roles of a connection and the connect command', () => {
    const roles = [
      { role: 'content-agent', connectionId: 'a', model: 'm' },
      { role: 'dev-agent', connectionId: 'b', model: null },
    ];
    expect(rolesOf(roles, 'a')).toEqual(['content-agent']);
    expect(rolesOf(roles, 'c')).toEqual([]);
    expect(connectCommand('anna')).toBe(
      'docker compose exec -it agent-runner cms-connect claude-code --user anna',
    );
  });

  it('reads the subscription status the agent-runner answered', () => {
    const of = (type: ConnectionType, linked?: boolean | null) =>
      subscriptionState({ type, subscription: linked === undefined ? undefined : { linked } });
    expect(of('subscription', true)).toBe('linked');
    expect(of('subscription', false)).toBe('not_linked');
    // The runner did not answer: the state is unknown, not "not linked".
    expect(of('subscription', null)).toBe('unknown');
    expect(of('subscription')).toBe('unknown');
    expect(of('api', true)).toBeNull();
    expect(SUBSCRIPTION_LABEL.linked).toBe('Abbonamento collegato');
    expect(SUBSCRIPTION_LABEL.not_linked).toBe('Abbonamento non collegato');
    expect(SUBSCRIPTION_LABEL.unknown).toBe('Collegamento non verificabile');
  });
});
