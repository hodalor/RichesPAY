import { runWithSystemScope } from "../db";
import type { AppDatabase } from "../db";

export async function detectNetworkFromMsisdn(
  database: AppDatabase,
  input: {
    countryCode: string;
    msisdn: string;
  }
): Promise<string | null> {
  const normalized = normalizeMsisdn(input.msisdn);

  return runWithSystemScope(
    database,
    "detect network from msisdn prefix",
    async (trx) => {
      const prefixes = await trx
        .selectFrom("msisdn_prefixes")
        .select(["prefix", "network"])
        .where("country_code", "=", input.countryCode)
        .orderBy("prefix desc")
        .execute();

      return prefixes.find((entry) => normalized.startsWith(entry.prefix))?.network ?? null;
    },
    { audit: false }
  );
}

function normalizeMsisdn(value: string): string {
  return value.replace(/[^\d]/g, "");
}
