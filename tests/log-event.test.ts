import { describe, expect, it } from 'vitest';
import { logMessageCopyText, parseLogMessage } from '../src/lib/log-event';

describe('parseLogMessage', () => {
  it('collapses whitespace for the one-line preview', () => {
    const p = parseLogMessage('hello\n  world\tfrom logs');
    expect(p.preview).toBe('hello world from logs');
    expect(p.json).toBeUndefined();
    expect(p.text).toBe('hello\n  world\tfrom logs');
  });

  it('pretty-prints a whole-message JSON object', () => {
    const p = parseLogMessage('{"name":"Shubham","ok":true}');
    expect(p.json).toBe('{\n  "name": "Shubham",\n  "ok": true\n}');
    expect(p.prefix).toBeUndefined();
  });

  it('pretty-prints a trailing JSON body after a Lambda prefix', () => {
    const msg = '2026-11-13T18:15:23.849Z\t70b2de18-4a33-49f2-a3ce-cce056ac2897\tINFO\t{"name":"Shubham"}';
    const p = parseLogMessage(msg);
    expect(p.json).toBe('{\n  "name": "Shubham"\n}');
    expect(p.prefix).toBe('2026-11-13T18:15:23.849Z 70b2de18-4a33-49f2-a3ce-cce056ac2897 INFO');
    expect(p.preview).toContain('{"name":"Shubham"}');
  });

  it('picks up JSON after a label following the Lambda prefix', () => {
    const msg = '2026-11-13T18:15:23.849Z\t70b2de18-4a33-49f2-a3ce-cce056ac2897\tINFO\tevent {"name":"Shubham"}';
    const p = parseLogMessage(msg);
    expect(p.json).toBe('{\n  "name": "Shubham"\n}');
    expect(p.prefix).toBe('2026-11-13T18:15:23.849Z 70b2de18-4a33-49f2-a3ce-cce056ac2897 INFO event');
  });

  it('leaves START / REPORT lines as preformatted text', () => {
    const msg = 'START RequestId: 70b2de18-4a33-49f2-a3ce-cce056ac2897 Version: $LATEST';
    const p = parseLogMessage(msg);
    expect(p.json).toBeUndefined();
    expect(p.text).toBe(msg);
  });

  it('handles a bare array and invalid JSON', () => {
    expect(parseLogMessage('[1,2]').json).toBe('[\n  1,\n  2\n]');
    const bad = parseLogMessage('not {json');
    expect(bad.json).toBeUndefined();
    expect(bad.text).toBe('not {json');
  });

  it('treats empty or missing messages as empty text', () => {
    expect(parseLogMessage(undefined).preview).toBe('');
    expect(parseLogMessage('').text).toBe('');
  });
});

describe('logMessageCopyText', () => {
  it('copies pretty JSON, with the prefix when present', () => {
    const p = parseLogMessage('2026-11-13T18:15:23.849Z\tabc-def0-1234-5678-abcdef012345\tINFO\t{"a":1}');
    expect(logMessageCopyText(p)).toBe('2026-11-13T18:15:23.849Z abc-def0-1234-5678-abcdef012345 INFO\n{\n  "a": 1\n}');
    expect(logMessageCopyText(parseLogMessage('just text'))).toBe('just text');
  });
});
