import type { Config } from '../types';
export type ConfigPatch = Partial<Omit<Config, 'retention'>> & {
  retention?: Partial<Config['retention']>;
};
export const CONFIG_LIMITS = {
  maxBulkOpen: { min: 1, max: 500 },
  port: { min: 1, max: 65535 },
  maxEntries: { min: 100, max: 100000 },
  maxDays: { min: 1, max: 36500 },
} as const;
export function inLimit(
  value: number,
  limit: {
    min: number;
    max: number;
  },
): boolean {
  return Number.isInteger(value) && value >= limit.min && value <= limit.max;
}
