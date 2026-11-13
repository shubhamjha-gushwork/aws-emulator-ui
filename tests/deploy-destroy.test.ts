import { describe, expect, it } from 'vitest';
import { clusterFrom, isAlreadyGone } from '@/lib/deploy/destroy';

describe('destroy cluster lookup', () => {
  it('prefers extra.cluster, then the manifest cluster, and never uses only the service name when a fallback exists', () => {
    expect(clusterFrom({ kind: 'ecs-service', name: 'gw-rpa', extra: { cluster: 'gw-agent-reverse-proxy-local' } })).toBe(
      'gw-agent-reverse-proxy-local',
    );
    expect(clusterFrom({ kind: 'ecs-service', name: 'argus-ui' }, 'argus-ui-local')).toBe('argus-ui-local');
    expect(clusterFrom({ kind: 'ecs-service', name: 'sample-web' })).toBe('sample-web');
  });
});

describe('isAlreadyGone', () => {
  it('treats not-found style errors as success', () => {
    expect(isAlreadyGone({ message: 'Cluster not found: gw-rpa' })).toBe(true);
    expect(isAlreadyGone({ name: 'ResourceNotFoundException', message: 'Secrets Manager can\'t find the specified secret.' })).toBe(true);
    expect(isAlreadyGone({ message: 'Invalid API id specified' })).toBe(true);
    expect(isAlreadyGone({ message: 'The cluster cannot be deleted while services are active.' })).toBe(false);
  });
});
