import { sql } from "kysely";

import { runWithSystemScope, type AppDatabase } from "../db";

interface BalanceMismatch {
  accountId: string;
  cachedBalance: bigint;
  computedBalance: bigint;
}

interface VerifyBalancesOptions {
  onAlert?: (mismatches: BalanceMismatch[]) => Promise<void> | void;
  reason?: string;
}

export async function verifyBalances(
  database: AppDatabase,
  options: VerifyBalancesOptions = {}
): Promise<BalanceMismatch[]> {
  const mismatches = await runWithSystemScope(
    database,
    options.reason ?? "verify ledger balances",
    async (trx) => {
      const result = await sql<BalanceMismatch>`
        with computed as (
          select
            p.account_id,
            coalesce(
              sum(
                case p.direction
                  when 'credit' then p.amount
                  else -p.amount
                end
              ),
              0
            )::bigint as computed_balance
          from public.postings p
          group by p.account_id
        )
        select
          ab.account_id as "accountId",
          ab.balance as "cachedBalance",
          coalesce(c.computed_balance, 0)::bigint as "computedBalance"
        from public.account_balances ab
        left join computed c on c.account_id = ab.account_id
        where ab.balance <> coalesce(c.computed_balance, 0)::bigint
        order by ab.account_id
      `.execute(trx);

      return result.rows;
    }
  );

  if (mismatches.length > 0) {
    await options.onAlert?.(mismatches);
    throw new Error(`Ledger balance verification failed for ${mismatches.length} accounts`);
  }

  return mismatches;
}

export type { BalanceMismatch, VerifyBalancesOptions };
