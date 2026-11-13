/** Shared (client + server) helpers for classifying CloudWatch log groups and UI-captured streams. */

/** Marker in stream names written by the UI itself (Lambda invoke log tails captured into CloudWatch). */
export const UI_CAPTURE_MARKER = 'captured-by-ui';

export const isUiCapturedStream = (name: string | undefined) => !!name && name.includes(UI_CAPTURE_MARKER);

export type LogSource = 'lambda' | 'ecs' | 'other';

/** Classify a log group by name; `ecsGroups` are groups referenced by ECS task definitions (awslogs-group). */
export function logSource(group: string, ecsGroups: Iterable<string> = []): LogSource {
  if (group.startsWith('/aws/lambda/')) return 'lambda';
  if (group.startsWith('/ecs/') || group.startsWith('/aws/ecs/')) return 'ecs';
  for (const g of ecsGroups) if (g === group) return 'ecs';
  return 'other';
}

/** Lambda-style stream name for a log tail captured by the UI, e.g. `2026/11/13/[$LATEST]captured-by-ui-<requestId>`. */
export function capturedStreamName(version: string | undefined, requestId: string, now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '/');
  return `${d}/[${version || '$LATEST'}]${UI_CAPTURE_MARKER}-${requestId}`;
}

/** Link to the full-page view of one log group (names contain slashes, so encode as one segment). */
export const groupHref = (name: string) => `/logs/${encodeURIComponent(name)}`;
