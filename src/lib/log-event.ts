/**
 * Parse a CloudWatch Logs event message for the expandable event view.
 * Pretty-prints JSON when the whole message, or a trailing JSON portion after
 * a Lambda runtime prefix (`2026-…\tRequestId\tINFO\t{…}`), is valid JSON.
 */

export interface ParsedLogMessage {
  /** Single-line, whitespace-collapsed preview for the collapsed row. */
  preview: string;
  /** Original message text (shown when there is no JSON body). */
  text: string;
  /** Pretty-printed JSON when a JSON body was parsed. */
  json?: string;
  /** Text before a trailing JSON body (Lambda prefix and any label). */
  prefix?: string;
}

const LAMBDA_PREFIX = /^(\d{4}-\d{2}-\d{2}T[^\s\t]+Z\t[0-9a-fA-F-]{8,}\t[A-Z]+\t)(.*)$/s;

function prettyJson(s: string): string | undefined {
  const t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[' && t[0] !== '"')) return undefined;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return undefined;
  }
}

/** First `{` or `[` that parses as JSON through the end of the string. */
function trailingJson(s: string): { before: string; json: string } | undefined {
  for (const c of ['{', '['] as const) {
    const i = s.indexOf(c);
    if (i < 0) continue;
    const json = prettyJson(s.slice(i));
    if (json) return { before: s.slice(0, i), json };
  }
  return undefined;
}

function previewOf(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function tabsToSpaces(s: string): string {
  return s.replace(/\t/g, ' ').trimEnd();
}

export function parseLogMessage(message: string | undefined | null): ParsedLogMessage {
  const raw = message ?? '';
  const preview = previewOf(raw);

  const whole = prettyJson(raw);
  if (whole) return { preview: preview || whole.split('\n')[0], text: raw, json: whole };

  const m = LAMBDA_PREFIX.exec(raw);
  if (m) {
    const rest = m[2];
    const direct = prettyJson(rest);
    if (direct) return { preview, text: raw, json: direct, prefix: tabsToSpaces(m[1]) };
    const sliced = trailingJson(rest);
    if (sliced) {
      return { preview, text: raw, json: sliced.json, prefix: tabsToSpaces(m[1] + sliced.before) };
    }
  }

  const sliced = trailingJson(raw);
  if (sliced) {
    return { preview, text: raw, json: sliced.json, prefix: tabsToSpaces(sliced.before) || undefined };
  }

  return { preview, text: raw };
}

/** Text copied from the expanded view: pretty JSON (with prefix) or the original message. */
export function logMessageCopyText(parsed: ParsedLogMessage): string {
  if (parsed.json) return parsed.prefix ? `${parsed.prefix}\n${parsed.json}` : parsed.json;
  return parsed.text;
}

export function logEventKey(e: { eventId?: string; timestamp?: number; logStreamName?: string; message?: string }, fallback: number | string): string {
  return e.eventId ?? `${e.timestamp ?? ''}|${e.logStreamName ?? ''}|${e.message ?? ''}|${fallback}`;
}
