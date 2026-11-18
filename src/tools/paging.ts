import { z } from 'zod';
import { numeric } from './schema.js';

/** How many records a list tool returns when the caller does not say. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * The `limit` and `cursor` arguments of the list tools whose results grow with the instance.
 * Every result stays in the model's context for the rest of the session, so an instance with
 * hundreds of monitors should not put all of them there to answer a question about a few.
 */
export function pagingParams(noun: string) {
  return {
    limit: numeric(z.number().int().positive())
      .optional()
      .describe(`How many ${noun} to return (default: ${DEFAULT_PAGE_LIMIT})`),
    cursor: z.string().optional().describe('The nextCursor of the previous call, for the next page'),
  };
}

/** The output fields the paged list tools add next to their records and `count`. */
export const pagingOutput = {
  total: z.number().describe('How many match the filters, across every page'),
  nextCursor: z.string().optional().describe('Pass as cursor for the next page; absent on the last page'),
};

export interface Page<T> {
  page: T[];
  total: number;
  nextCursor?: string;
}

/**
 * One page of records, in ID order. The cursor is the last ID of the previous page rather than
 * an offset, so a record created or deleted between two calls does not shift the next page and
 * make the caller skip or repeat one.
 */
export function pageById<T extends { id?: number }>(
  records: readonly T[],
  limit: number | undefined,
  cursor: string | undefined
): Page<T> {
  let after = -Infinity;
  if (cursor !== undefined) {
    after = Number(cursor.trim());
    if (cursor.trim() === '' || !Number.isInteger(after)) {
      throw new Error(`Invalid cursor "${cursor}". Pass the nextCursor of the previous call, or leave it out.`);
    }
  }
  const sorted = [...records].sort((a, b) => (a.id ?? -1) - (b.id ?? -1));
  const rest = sorted.filter((r) => (r.id ?? -1) > after);
  const size = limit ?? DEFAULT_PAGE_LIMIT;
  const page = rest.slice(0, size);
  const last = page[page.length - 1];
  return {
    page,
    total: sorted.length,
    ...(rest.length > size && last?.id !== undefined && { nextCursor: String(last.id) }),
  };
}

/**
 * The line a truncated page adds to its text, for clients that only show the model the text
 * block: without it the model would take the first page for the whole list.
 */
export function pageNote(noun: string, { page, total, nextCursor }: Page<unknown>): string | undefined {
  if (nextCursor === undefined) return undefined;
  return `Showing ${page.length} of ${total} ${noun}. For the next page, call again with cursor "${nextCursor}".`;
}
