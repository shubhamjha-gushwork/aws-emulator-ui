/** Create-only mode: resources are created, but nothing is scheduled or started. */
export function triggerState(noRun: boolean): 'ENABLED' | 'DISABLED' {
  return noRun ? 'DISABLED' : 'ENABLED';
}

export function triggerEnabled(noRun: boolean): boolean {
  return !noRun;
}

/** --no-run always forces 0, even if --desired-count or the config says otherwise. */
export function serviceDesiredCount(noRun: boolean, override?: number, fromConfig?: number): number {
  if (noRun) return 0;
  return override ?? fromConfig ?? 1;
}

export function noRunDetail(noRun: boolean, base?: string): string {
  const tag = noRun ? 'DISABLED (--no-run)' : undefined;
  return [base, tag].filter(Boolean).join(' · ');
}
