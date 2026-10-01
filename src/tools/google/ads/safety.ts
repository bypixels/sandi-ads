import { z } from 'zod';

export const microsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A configured average daily budget ceiling, in the Google Ads account currency. */
export function assertDailyBudget(amountMicros: number): void {
  microsSchema.parse(amountMicros);
  const configured = process.env.ADS_MAX_DAILY_BUDGET_MICROS;
  if (!configured || !/^[1-9]\d*$/.test(configured)) {
    throw new Error('ADS_MAX_DAILY_BUDGET_MICROS must be configured before budget writes or campaign activation');
  }
  const ceiling = Number(configured);
  if (!Number.isSafeInteger(ceiling)) throw new Error('ADS_MAX_DAILY_BUDGET_MICROS must be a positive safe integer');
  if (amountMicros > ceiling) throw new Error('Daily budget exceeds ADS_MAX_DAILY_BUDGET_MICROS');
}
