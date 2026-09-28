import { sql } from "kysely";

import { newId, type CurrencyCode } from "@richespay/shared";

import type { ScopedTransaction } from "../db";
import type {
  JournalReferenceType,
  LedgerAccountType,
  PostingDirection,
  RpMode
} from "../db/types";

interface LedgerActorContext {
  actorId: string;
  actorType: "admin" | "api_key" | "system" | "user";
}

interface MerchantMoneyParams {
  amount: bigint;
  currency: CurrencyCode;
  merchantId: string;
  mode: RpMode;
}

interface ProviderMoneyParams extends MerchantMoneyParams {
  channelId: string;
}

interface CollectionCreditParams extends ProviderMoneyParams {
  collectionId: string;
  description?: string;
  feeAmount?: bigint;
  reserveAmount?: bigint;
}

interface TopupCreditParams extends MerchantMoneyParams {
  channelId?: string;
  description?: string;
  feeAmount?: bigint;
  sourceAccountType?: "provider_clearing" | "suspense";
  topupId: string;
}

interface PayoutHoldParams extends MerchantMoneyParams {
  description?: string;
  payoutId: string;
}

interface CompletePayoutParams extends ProviderMoneyParams {
  description?: string;
  payoutId: string;
}

interface ReleasePayoutHoldParams extends MerchantMoneyParams {
  description?: string;
  payoutId: string;
}

interface AirtimeHoldParams extends MerchantMoneyParams {
  /** An airtime order id, or a batch id when a bulk submission is held as one amount. */
  airtimeReference: string;
  description?: string;
}

interface CompleteAirtimeParams extends AirtimeHoldParams {
  channelId: string;
  providerCostAmount: bigint;
  providerCostCurrency: CurrencyCode;
}

interface ChargeFeeParams extends MerchantMoneyParams {
  description?: string;
  feeId: string;
}

interface ChargeSmsParams extends MerchantMoneyParams {
  description?: string;
  smsId: string;
}

interface ManualAdjustmentAccount {
  channelId?: string;
  merchantId: string | null;
  type: LedgerAccountType;
}

interface ManualAdjustmentParams {
  amount: bigint;
  creditAccount: ManualAdjustmentAccount;
  currency: CurrencyCode;
  debitAccount: ManualAdjustmentAccount;
  description: string;
  mode: RpMode;
  reason: string;
  referenceId: string;
}

interface PostingDraft {
  account: ManualAdjustmentAccount;
  amount: bigint;
  direction: PostingDirection;
}

function assertPositiveAmount(amount: bigint) {
  if (amount <= 0n) {
    throw new Error("Ledger amounts must be greater than zero");
  }
}

function assertAccountShape(account: ManualAdjustmentAccount) {
  const merchantScopedTypes = new Set<LedgerAccountType>([
    "merchant_available",
    "merchant_pending",
    "merchant_reserve",
    "merchant_payout_hold",
    "merchant_airtime_hold"
  ]);

  if (merchantScopedTypes.has(account.type) && account.merchantId === null) {
    throw new Error(`${account.type} requires a merchant_id`);
  }

  if (account.type === "provider_clearing" && !account.channelId) {
    throw new Error("provider_clearing requires a channel_id");
  }

  if (account.type !== "provider_clearing" && account.channelId) {
    throw new Error(`${account.type} does not accept a channel_id`);
  }
}

export class LedgerService {
  constructor(
    private readonly trx: ScopedTransaction,
    private readonly actor: LedgerActorContext
  ) {}

  async creditCollection(
    params: CollectionCreditParams
  ): Promise<LedgerJournalEntry> {
    const feeAmount = params.feeAmount ?? 0n;
    const reserveAmount = params.reserveAmount ?? 0n;
    if (feeAmount < 0n) {
      throw new Error("Collection fee cannot be negative");
    }

    if (feeAmount > params.amount) {
      throw new Error("Collection fee cannot exceed the collected amount");
    }

    const destinationAmount = params.amount - feeAmount;
    if (reserveAmount < 0n) {
      throw new Error("Collection reserve cannot be negative");
    }

    if (reserveAmount > destinationAmount) {
      throw new Error("Collection reserve cannot exceed merchant proceeds");
    }

    const availableAmount = destinationAmount - reserveAmount;

    return this.createJournal({
      currency: params.currency,
      description:
        params.description ?? `Credit collection ${params.collectionId}`,
      mode: params.mode,
      postings: [
        {
          account: {
            channelId: params.channelId,
            merchantId: null,
            type: "provider_clearing"
          },
          amount: params.amount,
          direction: "debit"
        },
        ...(availableAmount > 0n
          ? [{
              account: {
                merchantId: params.merchantId,
                type: "merchant_available" as const
              },
              amount: availableAmount,
              direction: "credit" as const
            }]
          : []),
        ...(reserveAmount > 0n
          ? [{
              account: {
                merchantId: params.merchantId,
                type: "merchant_reserve" as const
              },
              amount: reserveAmount,
              direction: "credit" as const
            }]
          : []),
        ...(feeAmount > 0n
          ? [{
              account: {
                merchantId: null,
                type: "platform_fees" as const
              },
              amount: feeAmount,
              direction: "credit" as const
            }]
          : [])
      ],
      referenceId: params.collectionId,
      referenceType: "collection"
    });
  }

  async creditTopup(params: TopupCreditParams): Promise<LedgerJournalEntry> {
    const feeAmount = params.feeAmount ?? 0n;
    if (feeAmount < 0n) {
      throw new Error("Top-up fee cannot be negative");
    }

    if (feeAmount > params.amount) {
      throw new Error("Top-up fee cannot exceed the funded amount");
    }

    const destinationAmount = params.amount - feeAmount;
    const sourceAccountType = params.sourceAccountType ?? "provider_clearing";

    if (sourceAccountType === "provider_clearing" && !params.channelId) {
      throw new Error("Top-up provider clearing requires a channel");
    }

    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Credit top-up ${params.topupId}`,
      mode: params.mode,
      postings: [
        {
          account:
            sourceAccountType === "provider_clearing"
              ? {
                  channelId: params.channelId!,
                  merchantId: null,
                  type: "provider_clearing"
                }
              : {
                  merchantId: null,
                  type: "suspense"
                },
          amount: params.amount,
          direction: "debit"
        },
        ...(destinationAmount > 0n
          ? [{
              account: {
                merchantId: params.merchantId,
                type: "merchant_available" as const
              },
              amount: destinationAmount,
              direction: "credit" as const
            }]
          : []),
        ...(feeAmount > 0n
          ? [{
              account: {
                merchantId: null,
                type: "platform_fees" as const
              },
              amount: feeAmount,
              direction: "credit" as const
            }]
          : [])
      ],
      referenceId: params.topupId,
      referenceType: "topup"
    });
  }

  async holdForPayout(params: PayoutHoldParams): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Hold payout ${params.payoutId}`,
      mode: params.mode,
      postings: [
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_available"
          },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_payout_hold"
          },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.payoutId,
      referenceType: "payout"
    });
  }

  async completePayout(params: CompletePayoutParams): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Complete payout ${params.payoutId}`,
      mode: params.mode,
      postings: [
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_payout_hold"
          },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: {
            channelId: params.channelId,
            merchantId: null,
            type: "provider_clearing"
          },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.payoutId,
      referenceType: "payout"
    });
  }

  async releasePayoutHold(
    params: ReleasePayoutHoldParams
  ): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description:
        params.description ?? `Release payout hold ${params.payoutId}`,
      mode: params.mode,
      postings: [
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_payout_hold"
          },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_available"
          },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.payoutId,
      referenceType: "payout"
    });
  }

  async holdForAirtime(params: AirtimeHoldParams): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Hold airtime ${params.airtimeReference}`,
      mode: params.mode,
      postings: [
        {
          account: { merchantId: params.merchantId, type: "merchant_available" },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: { merchantId: params.merchantId, type: "merchant_airtime_hold" },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.airtimeReference,
      referenceType: "airtime"
    });
  }

  async completeAirtime(params: CompleteAirtimeParams): Promise<LedgerJournalEntry[]> {
    const description = params.description ?? `Complete airtime ${params.airtimeReference}`;

    if (params.providerCostCurrency === params.currency) {
      return [
        await this.createJournal({
          currency: params.currency,
          description,
          mode: params.mode,
          postings: [
            {
              account: { merchantId: params.merchantId, type: "merchant_airtime_hold" },
              amount: params.amount,
              direction: "debit"
            },
            {
              account: { channelId: params.channelId, merchantId: null, type: "provider_clearing" },
              amount: params.amount,
              direction: "credit"
            }
          ],
          referenceId: params.airtimeReference,
          referenceType: "airtime"
        })
      ];
    }

    const merchantLeg = await this.createJournal({
      currency: params.currency,
      description: `${description} (merchant leg)`,
      mode: params.mode,
      postings: [
        {
          account: { merchantId: params.merchantId, type: "merchant_airtime_hold" },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: { merchantId: null, type: "fx_clearing" },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.airtimeReference,
      referenceType: "airtime"
    });

    const providerLeg = await this.createJournal({
      currency: params.providerCostCurrency,
      description: `${description} (provider leg)`,
      mode: params.mode,
      postings: [
        {
          account: { merchantId: null, type: "fx_clearing" },
          amount: params.providerCostAmount,
          direction: "debit"
        },
        {
          account: { channelId: params.channelId, merchantId: null, type: "provider_clearing" },
          amount: params.providerCostAmount,
          direction: "credit"
        }
      ],
      referenceId: params.airtimeReference,
      referenceType: "airtime"
    });

    return [merchantLeg, providerLeg];
  }

  async releaseAirtimeHold(params: AirtimeHoldParams): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Release airtime hold ${params.airtimeReference}`,
      mode: params.mode,
      postings: [
        {
          account: { merchantId: params.merchantId, type: "merchant_airtime_hold" },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: { merchantId: params.merchantId, type: "merchant_available" },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.airtimeReference,
      referenceType: "airtime"
    });
  }

  async chargeFee(params: ChargeFeeParams): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Charge fee ${params.feeId}`,
      mode: params.mode,
      postings: [
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_available"
          },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: {
            merchantId: null,
            type: "platform_fees"
          },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.feeId,
      referenceType: "fee"
    });
  }

  async chargeSms(params: ChargeSmsParams): Promise<LedgerJournalEntry> {
    return this.createJournal({
      currency: params.currency,
      description: params.description ?? `Charge SMS ${params.smsId}`,
      mode: params.mode,
      postings: [
        {
          account: {
            merchantId: params.merchantId,
            type: "merchant_available"
          },
          amount: params.amount,
          direction: "debit"
        },
        {
          account: {
            merchantId: null,
            type: "platform_sms_revenue"
          },
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.smsId,
      referenceType: "sms"
    });
  }

  async reverse(entryId: string, reason: string): Promise<LedgerJournalEntry> {
    if (reason.trim() === "") {
      throw new Error("Reversal reason is required");
    }

    const originalEntry = await this.trx
      .selectFrom("journal_entries")
      .selectAll()
      .where("id", "=", entryId)
      .executeTakeFirst();

    if (!originalEntry) {
      throw new Error(`Journal entry ${entryId} not found`);
    }

    const originalPostings = await this.trx
      .selectFrom("postings as p")
      .innerJoin("ledger_accounts as la", "la.id", "p.account_id")
      .select([
        "la.channel_id as channelId",
        "la.merchant_id as merchantId",
        "la.type as accountType",
        "p.amount as amount",
        "p.direction as direction"
      ])
      .where("p.journal_entry_id", "=", entryId)
      .orderBy("p.id")
      .execute();

    if (originalPostings.length === 0) {
      throw new Error(`Journal entry ${entryId} has no postings to reverse`);
    }

    return this.createJournal({
      currency: originalEntry.currency as CurrencyCode,
      description: `Reverse ${entryId}: ${reason}`,
      mode: originalEntry.mode,
      postings: originalPostings.map((posting) => {
        const account =
          posting.channelId === null
            ? {
                merchantId: posting.merchantId,
                type: posting.accountType
              }
            : {
                channelId: posting.channelId,
                merchantId: posting.merchantId,
                type: posting.accountType
              };

        return {
          account,
          amount: BigInt(posting.amount),
          direction: posting.direction === "debit" ? "credit" : "debit"
        };
      }),
      referenceId: entryId,
      referenceType: "reversal"
    });
  }

  async manualAdjustment(
    params: ManualAdjustmentParams
  ): Promise<LedgerJournalEntry> {
    if (this.actor.actorType !== "admin") {
      throw new Error("manualAdjustment is admin only");
    }

    if (params.reason.trim() === "") {
      throw new Error("manualAdjustment reason is required");
    }

    const roleResult = await sql<{ current_role: string }>`
      select current_role
    `.execute(this.trx);
    const currentRole = roleResult.rows[0]?.current_role;

    if (currentRole !== "richespay_system") {
      throw new Error("manualAdjustment requires system scope");
    }

    return this.createJournal({
      currency: params.currency,
      description: `${params.description} (reason: ${params.reason})`,
      mode: params.mode,
      postings: [
        {
          account: params.debitAccount,
          amount: params.amount,
          direction: "debit"
        },
        {
          account: params.creditAccount,
          amount: params.amount,
          direction: "credit"
        }
      ],
      referenceId: params.referenceId,
      referenceType: "adjustment"
    });
  }

  private async createJournal(input: {
    currency: CurrencyCode;
    description: string;
    mode: RpMode;
    postings: PostingDraft[];
    referenceId: string;
    referenceType: JournalReferenceType;
  }): Promise<LedgerJournalEntry> {
    if (input.description.trim() === "") {
      throw new Error("Ledger journal description is required");
    }

    const resolvedPostings = [];

    for (const posting of input.postings) {
      assertPositiveAmount(posting.amount);
      assertAccountShape(posting.account);

      const accountId = await this.ensureAccount(
        posting.account,
        input.mode,
        input.currency
      );

      resolvedPostings.push({
        accountId,
        amount: posting.amount,
        direction: posting.direction
      });
    }

    await this.lockBalanceRows(resolvedPostings.map((posting) => posting.accountId));

    const journalEntry: LedgerJournalEntry = {
      created_at: new Date(),
      created_by: this.actor.actorId,
      currency: input.currency,
      description: input.description,
      id: newId("jrn_"),
      mode: input.mode,
      reference_id: input.referenceId,
      reference_type: input.referenceType
    };

    await this.trx
      .insertInto("journal_entries")
      .values(journalEntry)
      .execute();

    await this.trx
      .insertInto("postings")
      .values(
        resolvedPostings.map((posting) => ({
          account_id: posting.accountId,
          amount: posting.amount,
          direction: posting.direction,
          id: newId("pst_"),
          journal_entry_id: journalEntry.id
        }))
      )
      .execute();

    return journalEntry;
  }

  private async ensureAccount(
    account: ManualAdjustmentAccount,
    mode: RpMode,
    currency: CurrencyCode
  ): Promise<string> {
    const insertedAccount = await this.trx
      .insertInto("ledger_accounts")
      .values({
        channel_id: account.channelId ?? null,
        currency,
        id: newId("lac_"),
        merchant_id: account.merchantId,
        mode,
        type: account.type
      })
      .onConflict((conflict) =>
        conflict
          .columns(["merchant_id", "mode", "currency", "type", "channel_id"])
          .doNothing()
      )
      .returning("id")
      .executeTakeFirst();

    if (insertedAccount?.id) {
      return insertedAccount.id;
    }

    const existingAccount = await sql<{ id: string }>`
      select id
      from public.ledger_accounts
      where merchant_id is not distinct from ${account.merchantId}
        and mode = ${mode}
        and currency = ${currency}
        and type = ${account.type}
        and channel_id is not distinct from ${account.channelId ?? null}
      limit 1
    `.execute(this.trx);

    const accountId = existingAccount.rows[0]?.id;
    if (!accountId) {
      throw new Error("Unable to resolve ledger account");
    }

    return accountId;
  }

  private async lockBalanceRows(accountIds: string[]) {
    const uniqueAccountIds = [...new Set(accountIds)].sort((left, right) =>
      left.localeCompare(right)
    );

    if (uniqueAccountIds.length === 0) {
      return;
    }

    await this.trx
      .selectFrom("account_balances")
      .select("account_id")
      .where("account_id", "in", uniqueAccountIds)
      .orderBy("account_id")
      .forUpdate()
      .execute();
  }
}

export type {
  AirtimeHoldParams,
  ChargeFeeParams,
  CompleteAirtimeParams,
  ChargeSmsParams,
  CollectionCreditParams,
  CompletePayoutParams,
  LedgerActorContext,
  ManualAdjustmentAccount,
  ManualAdjustmentParams,
  PayoutHoldParams,
  TopupCreditParams,
  ReleasePayoutHoldParams
};

interface LedgerJournalEntry {
  created_at: Date;
  created_by: string;
  currency: string;
  description: string;
  id: string;
  mode: RpMode;
  reference_id: string;
  reference_type: JournalReferenceType;
}
