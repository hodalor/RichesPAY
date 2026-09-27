import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { ErrorCode } from "@richespay/shared";

export type Currency = "GHS" | "USD" | "ZMW";
export type CollectionMethod = "card" | "mobile_money";
export type PayoutMethod = "bank" | "mobile_money";
export type CheckoutMethod = CollectionMethod;
export type FeeBearer = "customer" | "merchant";
export type SmsMessageEncoding = "gsm7" | "ucs2";
export type SmsMessageType = "marketing" | "otp" | "transactional";
export type SmsMessageStatus =
  | "delivered"
  | "failed"
  | "queued"
  | "rejected"
  | "sent"
  | "undelivered";
export type SmsBatchStatus = "completed" | "partial" | "processing" | "queued";
export type SmsOtpStatus = "expired" | "failed" | "pending" | "verified";
export type CollectionStatus =
  | "cancelled"
  | "expired"
  | "failed"
  | "pending"
  | "processing"
  | "refunded"
  | "successful";
export type RefundStatus = "failed" | "pending" | "processing" | "successful";
export type PayoutStatus =
  | "cancelled"
  | "failed"
  | "on_hold"
  | "pending_approval"
  | "processing"
  | "queued"
  | "reversed"
  | "successful";
export type PayoutBatchStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "on_hold"
  | "pending_approval"
  | "processing"
  | "queued";
export type CheckoutSessionStatus = "completed" | "expired" | "open";
export type Json =
  | boolean
  | null
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export interface PaginationMeta {
  has_more: boolean;
  next_starting_after: string | null;
}

export interface ListResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface RichesPayConfig {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

export interface RequestOptions {
  headers?: Record<string, string> | undefined;
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ListOptions {
  created_gte?: string;
  created_lte?: string;
  limit?: number;
  reference?: string;
  starting_after?: string;
}

export interface CollectionListOptions extends ListOptions {
  status?: CollectionStatus;
}

export interface PayoutListOptions extends ListOptions {
  batch_id?: string;
  status?: PayoutStatus;
}

export interface PayoutBatchListOptions extends ListOptions {
  status?: PayoutBatchStatus;
}

export interface SmsListOptions extends ListOptions {
  batch_id?: string;
  status?: SmsMessageStatus;
  to?: string;
  type?: SmsMessageType;
}

export interface Collection {
  amount: number;
  card: {
    brand: string | null;
    expiry_month: number | null;
    expiry_year: number | null;
    last4: string | null;
  } | null;
  channel_id: string | null;
  completed_at: string | null;
  created_at: string;
  currency: Currency;
  customer: {
    email: string | null;
    name: string | null;
  };
  description: string | null;
  expires_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  fee_bearer: FeeBearer;
  fee_minor: number;
  fx_rate_id: string | null;
  id: string;
  method: CollectionMethod;
  net_minor: number;
  network: string | null;
  next_action: {
    iframe_url?: string;
    type: "hosted_fields" | "redirect_url";
    url?: string;
  } | null;
  phone: string | null;
  presentment_amount: number | null;
  presentment_currency: Currency | null;
  provider_ref: string | null;
  reference: string | null;
  refunded_minor: number;
  status: CollectionStatus;
}

export interface Refund {
  amount: number;
  channel_id: string | null;
  collection_id: string;
  completed_at: string | null;
  created_at: string;
  currency: Currency;
  failure_code: string | null;
  failure_message: string | null;
  id: string;
  method: CollectionMethod;
  phone: string | null;
  provider_ref: string | null;
  status: RefundStatus;
}

export interface Payout {
  account_name: string | null;
  account_number: string | null;
  amount: number;
  approved_by: string | null;
  bank_code: string | null;
  batch_id: string | null;
  channel_id: string | null;
  completed_at: string | null;
  created_at: string;
  created_by: string;
  currency: Currency;
  failure_code: string | null;
  failure_message: string | null;
  fee_minor: number;
  id: string;
  metadata: Record<string, Json>;
  method: PayoutMethod;
  narration: string | null;
  network: string | null;
  phone: string | null;
  provider_ref: string | null;
  reference: string | null;
  send_attempts: number;
  status: PayoutStatus;
  status_check_attempts: number;
  total_hold_minor: number;
}

export interface PayoutBatch {
  approved_by: string | null;
  completed_at: string | null;
  created_at: string;
  created_by: string;
  currency: Currency;
  id: string;
  item_count: number;
  metadata: Record<string, Json>;
  payouts: Payout[];
  reference: string | null;
  status: PayoutBatchStatus;
  total_amount: number;
  total_fee_minor: number;
  total_hold_minor: number;
  validation_report: {
    invalid_count: number;
    rows: Array<{
      errors: string[];
      index: number;
    }>;
    valid_count: number;
  };
}

export type PayoutBatchCreateResult =
  | {
      accepted: false;
      validation_report: PayoutBatch["validation_report"];
    }
  | {
      accepted: true;
      batch: PayoutBatch;
    };

export interface SmsMessage {
  batch_id: string | null;
  body: string;
  channel_id: string | null;
  created_at: string;
  currency: string;
  delivered_at: string | null;
  encoding: SmsMessageEncoding;
  failure_code: string | null;
  id: string;
  metadata: Record<string, Json>;
  price_minor: number;
  provider_ref: string | null;
  reference: string | null;
  scheduled_at: string | null;
  segments: number;
  sender_id: string;
  sent_at: string | null;
  status: SmsMessageStatus;
  to: string;
  type: SmsMessageType;
}

export interface SmsBatch {
  accepted_count: number;
  body: string;
  created_at: string;
  created_by: string;
  id: string;
  messages: SmsMessage[];
  metadata: Record<string, Json>;
  reference: string | null;
  rejected_count: number;
  scheduled_at: string | null;
  sender_id: string | null;
  status: SmsBatchStatus;
  total_count: number;
  type: SmsMessageType;
  updated_at: string;
}

export interface OtpSendResult {
  expires_at: string;
  otp_id: string;
  sms_id: string;
}

export interface OtpVerifyResult {
  attempts: number;
  expires_at: string;
  otp_id: string;
  status: SmsOtpStatus;
  verified: boolean;
  verified_at: string | null;
}

export interface CheckoutSession {
  allowed_methods: CheckoutMethod[];
  amount: number;
  amount_formatted: string;
  cancel_url: string | null;
  collection: {
    card: {
      brand: string | null;
      expiry_month: number | null;
      expiry_year: number | null;
      last4: string | null;
    } | null;
    failure_code: string | null;
    failure_message: string | null;
    id: string;
    method: CheckoutMethod;
    network: string | null;
    next_action: {
      iframe_url?: string;
      type: "hosted_fields" | "redirect_url";
      url?: string;
    } | null;
    phone: string | null;
    provider_ref: string | null;
    status: string;
  } | null;
  currency: Currency;
  customer: {
    email: string | null;
    name: string | null;
  };
  description: string | null;
  expires_at: string;
  id: string;
  merchant: {
    display_name: string;
    id: string;
  };
  reference: string | null;
  status: CheckoutSessionStatus;
  success_url: string | null;
}

export interface CheckoutSessionLink {
  id: string;
  url: string;
}

export interface CollectionCreateParams {
  amount: number;
  cancel_url?: string;
  currency: Currency;
  customer?: {
    email?: string;
    name?: string;
  };
  description?: string;
  metadata?: Record<string, Json>;
  method?: CollectionMethod;
  network?: string;
  phone?: string;
  reference?: string;
  return_url?: string;
}

export interface CollectionRefundParams {
  amount?: number;
}

export interface PayoutCreateParams {
  account_name?: string;
  account_number?: string;
  amount: number;
  bank_code?: string;
  currency: Currency;
  metadata?: Record<string, Json>;
  method?: PayoutMethod;
  narration?: string;
  network?: string;
  phone?: string;
  reference?: string;
}

export interface PayoutBatchCreateParams {
  currency: Currency;
  items: PayoutCreateParams[];
  metadata?: Record<string, Json>;
  reference?: string;
}

export interface SmsSendParams {
  message?: string;
  metadata?: Record<string, Json>;
  reference?: string;
  schedule_at?: string;
  sender_id?: string;
  template_id?: string;
  to: string;
  type: SmsMessageType;
  variables?: Record<string, boolean | null | number | string>;
}

export interface SmsBulkSendParams {
  contact_group_id?: string;
  message: string;
  metadata?: Record<string, Json>;
  reference?: string;
  schedule_at?: string;
  sender_id?: string;
  to?: Array<string | { name?: string; phone: string }>;
  type: SmsMessageType;
}

export interface OtpSendParams {
  expires_in_seconds: number;
  length: number;
  sender_id?: string;
  template?: string;
  to: string;
}

export interface OtpVerifyParams {
  code: string;
  otp_id: string;
}

export interface CheckoutSessionCreateParams {
  allowed_methods: CheckoutMethod[];
  amount: number;
  cancel_url?: string;
  currency: Currency;
  customer?: {
    email?: string;
    name?: string;
  };
  description?: string;
  reference?: string;
  success_url?: string;
}

export interface CheckoutSessionPayParams {
  method?: CheckoutMethod;
  network?: string;
  phone?: string;
}

interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

interface ApiErrorEnvelope {
  error: {
    code: ErrorCode;
    field?: string;
    message: string;
    request_id?: string;
  };
}

export class RichesPayError extends Error {
  code: ErrorCode;
  field: string | undefined;
  requestId: string | undefined;
  statusCode: number;

  constructor(input: {
    code: ErrorCode;
    field?: string;
    message: string;
    requestId?: string;
    statusCode: number;
  }) {
    super(input.message);
    this.name = "RichesPayError";
    this.code = input.code;
    this.field = input.field;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
  }
}

export function isRichesPayError(error: unknown): error is RichesPayError {
  return error instanceof RichesPayError;
}

export class RichesPay {
  readonly checkout: {
    sessions: CheckoutSessionsResource;
  };
  readonly collections: CollectionsResource;
  readonly otp: OtpResource;
  readonly payoutBatches: PayoutBatchesResource;
  readonly payouts: PayoutsResource;
  readonly sms: SmsResource;
  readonly webhooks: WebhooksResource;

  #baseUrl: string;
  #fetch: typeof globalThis.fetch;
  #secretKey: string;
  #userAgent: string;

  constructor(secretKey: string, config: RichesPayConfig = {}) {
    if (!secretKey.trim()) {
      throw new Error("A RichesPay secret key is required.");
    }

    if (typeof globalThis.fetch !== "function" && !config.fetch) {
      throw new Error("Global fetch is unavailable. Pass a fetch implementation in the SDK config.");
    }

    this.#secretKey = secretKey;
    this.#baseUrl = config.baseUrl ?? "https://api.richespay.com";
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.#userAgent = config.userAgent ?? "@richespay/node";

    this.collections = new CollectionsResource(this);
    this.payouts = new PayoutsResource(this);
    this.payoutBatches = new PayoutBatchesResource(this);
    this.sms = new SmsResource(this);
    this.otp = new OtpResource(this);
    this.checkout = {
      sessions: new CheckoutSessionsResource(this)
    };
    this.webhooks = new WebhooksResource();
  }

  async requestEnvelope<T>(input: {
    body?: unknown;
    idempotencyKey?: string | undefined;
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean | undefined> | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ApiEnvelope<T>> {
    const url = new URL(input.path, ensureTrailingSlash(this.#baseUrl));
    if (input.query) {
      for (const [key, value] of Object.entries(input.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.#secretKey}`,
      "User-Agent": this.#userAgent
    });

    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    if (input.method === "POST") {
      headers.set("Idempotency-Key", input.idempotencyKey ?? randomUUID());
    }

    const response = await this.#fetch(url, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers,
      method: input.method,
      ...(input.signal ? { signal: input.signal } : {})
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      const apiError = isApiErrorEnvelope(payload) ? payload.error : undefined;
      throw new RichesPayError({
        code: apiError?.code ?? "internal_error",
        ...(apiError?.field ? { field: apiError.field } : {}),
        message: apiError?.message ?? `RichesPay request failed with status ${response.status}.`,
        ...(apiError?.request_id ? { requestId: apiError.request_id } : {}),
        statusCode: response.status
      });
    }

    if (!isApiEnvelope<T>(payload)) {
      throw new Error("RichesPay returned an unexpected response payload.");
    }

    return payload;
  }
}

class CollectionsResource {
  #client: RichesPay;

  constructor(client: RichesPay) {
    this.#client = client;
  }

  async create(params: CollectionCreateParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Collection>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/collections",
      signal: options.signal
    });
    return envelope.data;
  }

  async createRefund(collectionId: string, params: CollectionRefundParams = {}, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Refund>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: `/v1/collections/${encodeURIComponent(collectionId)}/refunds`,
      signal: options.signal
    });
    return envelope.data;
  }

  async list(options: CollectionListOptions = {}, requestOptions: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Collection[]>({
      method: "GET",
      path: "/v1/collections",
      query: toQueryRecord(options),
      signal: requestOptions.signal
    });

    return {
      data: envelope.data,
      meta: coercePaginationMeta(envelope.meta)
    } satisfies ListResponse<Collection>;
  }

  async retrieve(collectionId: string, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Collection>({
      method: "GET",
      path: `/v1/collections/${encodeURIComponent(collectionId)}`,
      signal: options.signal
    });
    return envelope.data;
  }
}

class PayoutsResource {
  #client: RichesPay;

  constructor(client: RichesPay) {
    this.#client = client;
  }

  async create(params: PayoutCreateParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Payout>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/payouts",
      signal: options.signal
    });
    return envelope.data;
  }

  async list(options: PayoutListOptions = {}, requestOptions: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Payout[]>({
      method: "GET",
      path: "/v1/payouts",
      query: toQueryRecord(options),
      signal: requestOptions.signal
    });

    return {
      data: envelope.data,
      meta: coercePaginationMeta(envelope.meta)
    } satisfies ListResponse<Payout>;
  }

  async retrieve(payoutId: string, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<Payout>({
      method: "GET",
      path: `/v1/payouts/${encodeURIComponent(payoutId)}`,
      signal: options.signal
    });
    return envelope.data;
  }
}

class PayoutBatchesResource {
  #client: RichesPay;

  constructor(client: RichesPay) {
    this.#client = client;
  }

  async create(params: PayoutBatchCreateParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<PayoutBatchCreateResult>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/payout-batches",
      signal: options.signal
    });
    return envelope.data;
  }

  async list(options: PayoutBatchListOptions = {}, requestOptions: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<PayoutBatch[]>({
      method: "GET",
      path: "/v1/payout-batches",
      query: toQueryRecord(options),
      signal: requestOptions.signal
    });

    return {
      data: envelope.data,
      meta: coercePaginationMeta(envelope.meta)
    } satisfies ListResponse<PayoutBatch>;
  }

  async retrieve(batchId: string, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<PayoutBatch>({
      method: "GET",
      path: `/v1/payout-batches/${encodeURIComponent(batchId)}`,
      signal: options.signal
    });
    return envelope.data;
  }
}

class SmsResource {
  #client: RichesPay;

  constructor(client: RichesPay) {
    this.#client = client;
  }

  async list(options: SmsListOptions = {}, requestOptions: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<SmsMessage[]>({
      method: "GET",
      path: "/v1/sms",
      query: toQueryRecord(options),
      signal: requestOptions.signal
    });

    return {
      data: envelope.data,
      meta: coercePaginationMeta(envelope.meta)
    } satisfies ListResponse<SmsMessage>;
  }

  async retrieve(messageId: string, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<SmsMessage>({
      method: "GET",
      path: `/v1/sms/${encodeURIComponent(messageId)}`,
      signal: options.signal
    });
    return envelope.data;
  }

  async retrieveBatch(batchId: string, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<SmsBatch>({
      method: "GET",
      path: `/v1/sms/batches/${encodeURIComponent(batchId)}`,
      signal: options.signal
    });
    return envelope.data;
  }

  async send(params: SmsSendParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<SmsMessage>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/sms",
      signal: options.signal
    });
    return envelope.data;
  }

  async sendBulk(params: SmsBulkSendParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<{
      accepted_count: number;
      batch_id: string;
      rejected_count: number;
      total_count: number;
    }>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/sms/bulk",
      signal: options.signal
    });
    return envelope.data;
  }
}

class OtpResource {
  #client: RichesPay;

  constructor(client: RichesPay) {
    this.#client = client;
  }

  async send(params: OtpSendParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<OtpSendResult>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/otp/send",
      signal: options.signal
    });
    return envelope.data;
  }

  async verify(params: OtpVerifyParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<OtpVerifyResult>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/otp/verify",
      signal: options.signal
    });
    return envelope.data;
  }
}

class CheckoutSessionsResource {
  #client: RichesPay;

  constructor(client: RichesPay) {
    this.#client = client;
  }

  async create(params: CheckoutSessionCreateParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<CheckoutSessionLink>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/v1/checkout/sessions",
      signal: options.signal
    });
    return envelope.data;
  }

  async pay(sessionId: string, params: CheckoutSessionPayParams, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<CheckoutSession>({
      body: params,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/pay`,
      signal: options.signal
    });
    return envelope.data;
  }

  async retrieve(sessionId: string, options: RequestOptions = {}) {
    const envelope = await this.#client.requestEnvelope<CheckoutSession>({
      method: "GET",
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      signal: options.signal
    });
    return envelope.data;
  }
}

class WebhooksResource {
  verify(rawBody: Buffer | string | Uint8Array, signatureHeader: string, secret: string) {
    const parsed = parseSignatureHeader(signatureHeader);
    if (!parsed) {
      return false;
    }

    const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const expected = createHmac("sha256", secret)
      .update(Buffer.from(`${parsed.timestamp}.`))
      .update(payload)
      .digest("hex");

    const received = Buffer.from(parsed.signature, "hex");
    const computed = Buffer.from(expected, "hex");

    if (received.length !== computed.length) {
      return false;
    }

    return timingSafeEqual(received, computed);
  }
}

function coercePaginationMeta(meta: Record<string, unknown> | undefined): PaginationMeta {
  return {
    has_more: Boolean(meta?.has_more),
    next_starting_after:
      typeof meta?.next_starting_after === "string" ? meta.next_starting_after : null
  };
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function toQueryRecord<T extends object>(
  value: T
): Record<string, string | number | boolean | undefined> {
  return value as Record<string, string | number | boolean | undefined>;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }

  return response.json();
}

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return Boolean(value) && typeof value === "object" && "data" in (value as Record<string, unknown>);
}

function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  return Boolean(value) && typeof value === "object" && "error" in (value as Record<string, unknown>);
}

function parseSignatureHeader(header: string) {
  const parts = header.split(",").map((entry) => entry.trim());
  const timestampPart = parts.find((entry) => entry.startsWith("t="));
  const signaturePart = parts.find((entry) => entry.startsWith("v1="));

  if (!timestampPart || !signaturePart) {
    return null;
  }

  const timestamp = Number(timestampPart.slice(2));
  const signature = signaturePart.slice(3);
  if (!Number.isFinite(timestamp) || signature.length === 0) {
    return null;
  }

  return { signature, timestamp };
}
