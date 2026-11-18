export const textSetOperators = {
  eqAny: 'is equal to any of',
  neqAny: 'is not equal to any of',
  containsAny: 'contains any of',
  notContainsAny: 'doesn’t contain any of',
  startsAny: 'starts with any of',
  endsAny: 'ends with any of',
} as const;
export type TextSetOperator = keyof typeof textSetOperators;
export const isTextSetOperator = (operator: string): operator is TextSetOperator => Object.hasOwn(textSetOperators, operator);
export const isTextFilterType = (type: string) => ['text', 'email', 'url'].includes(type);
export const negativeTextOperator = (operator: string) => operator === 'neqAny' || operator === 'notContainsAny';
// Match SQLite's built-in lower() consistently, without changing legacy predicates.
export const normalizeTextFilter = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase());
export const parseTextFilterValues = (value: string) => value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
export function matchesTextSet(raw: unknown, operator: TextSetOperator, values: string[]) {
  if (typeof raw !== 'string' || !values.length) return false;
  const actual = normalizeTextFilter(raw);
  const matches = values.some(value => {
    const expected = normalizeTextFilter(value.trim());
    if (!expected) return false;
    switch (operator) {
      case 'eqAny': case 'neqAny': return actual === expected;
      case 'containsAny': case 'notContainsAny': return actual.includes(expected);
      case 'startsAny': return actual.startsWith(expected);
      case 'endsAny': return actual.endsWith(expected);
    }
  });
  return negativeTextOperator(operator) ? !matches : matches;
}
