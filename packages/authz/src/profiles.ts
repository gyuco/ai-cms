import { isUnder } from './paths.ts';
import type { Action, AgentProfile, AgentRule, NodeTarget } from './types.ts';

/** Content agent (FR-83): site content in db and s3, never code or schemas. */
export const contentAgentProfile: AgentProfile = {
  name: 'content-agent',
  envs: ['prod', 'staging'],
  allow: [
    {
      path: 'site',
      actions: ['read', 'list', 'traverse', 'write', 'create', 'delete', 'publish'],
      storages: ['db', 's3'],
    },
  ],
  deny: [{ path: 'system', actions: ['manage'] }],
};

const DEV_AGENT_ACTIONS: Action[] = [
  'read',
  'list',
  'traverse',
  'write',
  'create',
  'delete',
  'publish',
];

/** Developer agent (FR-84): site, data and code, staging only. */
export const devAgentProfile: AgentProfile = {
  name: 'dev-agent',
  envs: ['staging'],
  allow: [
    { path: 'site', actions: DEV_AGENT_ACTIONS },
    { path: 'data', actions: DEV_AGENT_ACTIONS },
    { path: 'code', actions: DEV_AGENT_ACTIONS },
  ],
  deny: [{ path: 'system', actions: ['manage'] }],
};

export function ruleMatches(rule: AgentRule, action: Action, target: NodeTarget): boolean {
  return (
    isUnder(target.path, rule.path) &&
    rule.actions.includes(action) &&
    (rule.storages === undefined || rule.storages.includes(target.storage))
  );
}
