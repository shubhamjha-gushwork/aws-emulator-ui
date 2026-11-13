'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Empty } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right';
}

export function DataTable<T>({ rows, columns, rowKey, onRowClick, selectedKey, empty = 'Nothing here yet.' }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; selectedKey?: string | null; empty?: ReactNode;
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-100 bg-neutral-25 text-xs font-semibold uppercase tracking-wide text-neutral-600">
            {columns.map((c) => (
              <th key={c.key} className={cn('whitespace-nowrap px-5 py-3', c.align === 'right' ? 'text-right' : 'text-left', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r);
            return (
              <tr
                key={k}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn(
                  'group border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-25',
                  onRowClick && 'cursor-pointer',
                  selectedKey === k && 'bg-primary-25 hover:bg-primary-25',
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-5 py-3 align-middle text-neutral-800', c.align === 'right' && 'text-right', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
