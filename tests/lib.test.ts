import { describe, expect, it } from 'vitest';
import { trimEpochPrecision } from '@/lib/compat';
import { parseIni } from '@/lib/emulator-files';
import { normalizeError, isNotImplemented } from '@/lib/errors';
import { sanitizeSettings, DEFAULT_SETTINGS, endpointPort } from '@/lib/settings';
import { toItem } from '@/lib/services/dynamodb';
import { str, num, strList, json, InputError } from '@/lib/services/types';
import { awsReplacer, stripMetadata } from '@/lib/serialize';
import { SERVICES } from '@/lib/catalog';
import { services } from '@/lib/services';

describe('trimEpochPrecision', () => {
  it('trims nanosecond epoch fractions to milliseconds', () => {
    expect(trimEpochPrecision('{"createdAt":1794581585.444590867,"n":1}')).toBe('{"createdAt":1794581585.444,"n":1}');
    expect(trimEpochPrecision('[{"a": 1794581585.4445908}]')).toBe('[{"a": 1794581585.444}]');
  });
  it('leaves normal numbers and strings alone', () => {
    const s = '{"price":12.3456789,"id":"1794581585.444590867","t":1794581585.123}';
    expect(trimEpochPrecision(s)).toBe(s);
  });
});

describe('parseIni', () => {
  it('reads the emulator credentials file', () => {
    const ini = parseIni('[default]\naws_access_key_id = AKIA_TEST\naws_secret_access_key=secret=with=eq\n# comment\n');
    expect(ini.default).toEqual({ aws_access_key_id: 'AKIA_TEST', aws_secret_access_key: 'secret=with=eq' });
  });
});

describe('errors', () => {
  it('flags NotImplemented answers', () => {
    expect(isNotImplemented('NotImplemented', 'x')).toBe(true);
    expect(isNotImplemented('Foo', 'x', 501)).toBe(true);
    expect(isNotImplemented('ValidationException', 'bad', 400)).toBe(false);
    const e = Object.assign(new Error('operation ExportApi is scaffolded but not implemented in this emulator'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
    expect(normalizeError(e)).toMatchObject({ name: 'NotImplemented', notImplemented: true, connection: false, status: 501 });
  });
  it('flags connection failures', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9297'), { code: 'ECONNREFUSED' });
    expect(normalizeError(e).connection).toBe(true);
  });
});

describe('settings', () => {
  it('normalizes endpoint to an origin and validates region', () => {
    const s = sanitizeSettings({ endpoint: 'https://127.0.0.1:9300/some/path', region: 'eu-west-1' });
    expect(s.endpoint).toBe('https://127.0.0.1:9300');
    expect(s.region).toBe('eu-west-1');
    expect(sanitizeSettings({ region: 'nope' }).region).toBe(DEFAULT_SETTINGS.region);
  });
  it('rejects non-http endpoints', () => {
    expect(() => sanitizeSettings({ endpoint: 'file:///etc/passwd' })).toThrow();
  });
  it('derives the run folder port', () => {
    expect(endpointPort('https://127.0.0.1:9297')).toBe(9297);
    expect(endpointPort('https://emulator.local')).toBe(443);
  });
});

describe('dynamodb item conversion', () => {
  it('marshalls plain JSON', () => {
    expect(toItem('{"id":"a","n":5,"tags":["x"],"ok":true}')).toEqual({ id: { S: 'a' }, n: { N: '5' }, tags: { L: [{ S: 'x' }] }, ok: { BOOL: true } });
  });
  it('rejects non-objects', () => {
    expect(() => toItem('[1,2]')).toThrow(InputError);
    expect(() => toItem('{bad')).toThrow(/not valid JSON/);
  });
});

describe('param helpers', () => {
  it('validates inputs', () => {
    expect(str({ a: 'x' }, 'a')).toBe('x');
    expect(() => str({}, 'a')).toThrow(InputError);
    expect(num({ n: '3' }, 'n')).toBe(3);
    expect(num({}, 'n', 7)).toBe(7);
    expect(strList({ s: 'a, b,,c' }, 's')).toEqual(['a', 'b', 'c']);
    expect(() => json('{', 'X')).toThrow(/X is not valid JSON/);
  });
});

describe('serialization', () => {
  it('handles Sets, bytes and bigint', () => {
    const out = JSON.parse(JSON.stringify({ s: new Set([1, 2]), b: new Uint8Array([104, 105]), n: BigInt(5) }, awsReplacer));
    expect(out).toEqual({ s: [1, 2], b: { base64: 'aGk=' }, n: '5' });
    expect(stripMetadata({ $metadata: {}, a: 1 })).toEqual({ a: 1 });
  });
});

describe('catalog', () => {
  it('covers the 13 v1 services, each with a backend module', () => {
    expect(SERVICES).toHaveLength(13);
    for (const s of SERVICES) {
      expect(services[s.id], s.id).toBeDefined();
    }
  });
});

import { arnRegion, inRegion, type Ctx } from '@/lib/services/types';
import { logSource, capturedStreamName, isUiCapturedStream } from '@/lib/log-sources';
import { orderStates } from '@/lib/asl';
import { REGIONS, regionName } from '@/lib/regions';

describe('region scoping', () => {
  const ctx = { cfg: { region: 'ap-south-1' } } as unknown as Ctx;
  it('reads the region out of an ARN', () => {
    expect(arnRegion('arn:aws:ecs:ap-south-1:000000000000:cluster/a')).toBe('ap-south-1');
    expect(arnRegion('arn:aws:iam::000000000000:role/x')).toBeUndefined();
    expect(arnRegion('not-an-arn')).toBeUndefined();
  });
  it('keeps same-region and region-less ARNs, drops other regions', () => {
    expect(inRegion(ctx, 'arn:aws:ecs:ap-south-1:000000000000:cluster/a')).toBe(true);
    expect(inRegion(ctx, 'arn:aws:ecs:us-east-1:000000000000:cluster/a')).toBe(false);
    expect(inRegion(ctx, 'arn:aws:iam::000000000000:role/x')).toBe(true);
    expect(inRegion(ctx, undefined)).toBe(true);
  });
  it('offers the configured regions with names', () => {
    expect(REGIONS.map((r) => r.code)).toEqual(['ap-south-1', 'ap-southeast-1', 'us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1']);
    expect(regionName('ap-south-1')).toBe('Asia Pacific (Mumbai)');
    expect(regionName('xx-test-9')).toBe('xx-test-9');
  });
});

describe('settings never keep credentials', () => {
  it('drops access keys and the old manual mode', () => {
    const s = sanitizeSettings({ region: 'ap-south-1', accessKeyId: 'AKIA', secretAccessKey: 'shh', credentialsMode: 'manual' } as never);
    expect(s).toEqual({ ...DEFAULT_SETTINGS, region: 'ap-south-1' });
    expect(Object.keys(s).sort()).toEqual(['endpoint', 'region', 'tlsVerify']);
  });
});

describe('log sources', () => {
  it('classifies groups by prefix and ECS task definitions', () => {
    expect(logSource('/aws/lambda/fn')).toBe('lambda');
    expect(logSource('/ecs/web')).toBe('ecs');
    expect(logSource('/aws/ecs/containerinsights/x')).toBe('ecs');
    expect(logSource('/custom/app', ['/custom/app'])).toBe('ecs');
    expect(logSource('/demo/app')).toBe('other');
  });
  it('labels streams captured by the UI', () => {
    const n = capturedStreamName('$LATEST', 'abc-123', new Date('2026-11-13T10:00:00Z'));
    expect(n).toBe('2026/11/13/[$LATEST]captured-by-ui-abc-123');
    expect(isUiCapturedStream(n)).toBe(true);
    expect(isUiCapturedStream('2026/11/13/[$LATEST]0123abcd')).toBe(false);
  });
});

describe('state machine step list', () => {
  it('orders states by transitions from StartAt', () => {
    const def = { StartAt: 'A', States: { Z: { Type: 'Pass', End: true }, C: { Type: 'Succeed' }, A: { Type: 'Choice', Choices: [{ Next: 'B' }], Default: 'C' }, B: { Type: 'Pass', Next: 'C' } } };
    expect(orderStates(def)).toEqual(['A', 'B', 'C', 'Z']);
  });
});
