import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  BookText,
  BriefcaseBusiness,
  CircleDollarSign,
  CreditCard,
  Download,
  KeyRound,
  Landmark,
  Link2,
  MessageSquareText,
  Phone,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  Users
} from "lucide-react";
import {
  AppShell,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyField,
  DataTable,
  DateRangePicker,
  Drawer,
  EmptyState,
  FilterBar,
  Input,
  Modal,
  MoneyText,
  PageHeader,
  Select,
  StatusBadge,
  SummaryCard,
  SummaryCardGrid,
  Tabs,
  Textarea,
  useToast,
  type ColumnDef,
  type DateRangeValue,
  type SidebarSection
} from "@richespay/ui";
import { formatMoney, fromMinor, toMinor, type CurrencyCode } from "@richespay/shared";

import { ApiError, apiRequest } from "../api-client";
import { env } from "../env";
import { supabase } from "../supabase";

type MerchantMode = "live" | "test";

interface WorkspaceAuth {
  accessToken: string | null;
  signOutEverywhere: () => Promise<void>;
}

interface MembershipSummary {
  merchant_id: string;
  merchant_name: string;
  mode: MerchantMode;
  role: string;
  settlement_currency: string;
  timezone: string;
}

interface SessionData {
  active_products: {
    airtime: boolean;
    collections: boolean;
    payouts: boolean;
    sms: boolean;
    sms_api: boolean;
    sms_broadcast: boolean;
  };
  compliance: {
    collections_freeze_category: string | null;
    collections_freeze_reason: string | null;
    collections_frozen: boolean;
    contact_link: string;
    payouts_freeze_category: string | null;
    payouts_freeze_reason: string | null;
    payouts_frozen: boolean;
    status: string;
    suspension_category: string | null;
    suspension_reason: string | null;
  };
  email: string | null;
  merchant_id: string;
  merchant_name: string;
  mode: MerchantMode;
  permissions: string[];
  role: string;
  settlement_currency: string;
  timezone: string;
  user_id: string;
}

interface SummaryData {
  active_products: SessionData["active_products"];
  balance: {
    available_minor: number;
    currency: string;
    on_hold_minor: number;
    pending_minor: number;
    reserve_minor: number;
  };
  collections: {
    pending: number;
    success_rate: number;
    successful: number;
    total_collected_minor: number;
  };
  messages: {
    delivery_rate: number;
    failed: number;
    pending: number;
    sent: number;
    spend_minor: number;
  };
  overview: {
    cards: {
      airtime_sent_today: number;
      airtime_spend_this_month_minor: number;
      airtime_success_rate: number;
      available_balance_minor: number;
      collected_today_minor: number;
      paid_out_today_minor: number;
      sms_sent_today: number;
    };
    chart: Array<{
      collections_amount_minor: number;
      date: string;
    }>;
    checklist: Array<{
      complete: boolean;
      key: string;
      label: string;
    }>;
    recent_transactions: Array<{
      amount_minor: number;
      created_at: string;
      currency: string;
      id: string;
      kind: "airtime" | "collection" | "payout" | "sms";
      reference: string | null;
      status: string;
    }>;
  };
  payment_links: {
    active_links: number;
    amount_collected_minor: number;
    payments_via_links: number;
  };
  payouts: {
    awaiting_approval: number;
    failed: number;
    paid_out_minor: number;
    successful: number;
    total: number;
  };
}

interface CollectionRow {
  amount: number;
  completed_at: string | null;
  created_at: string;
  currency: string;
  customer: {
    name: string | null;
    phone: string | null;
    phone_masked: string | null;
  };
  description: string | null;
  failure_code: string | null;
  failure_message: string | null;
  fee_minor: number;
  id: string;
  metadata: Record<string, unknown>;
  method: string;
  network: string | null;
  reference: string | null;
  status: string;
}

interface CollectionDetail extends CollectionRow {
  amount_breakdown: {
    fee_minor: number;
    gross_minor: number;
    net_minor: number;
  };
  event_timeline: Array<{
    created_at: string;
    from_status: string | null;
    provider_reference: string | null;
    reason: string | null;
    to_status: string;
  }>;
}

interface PayoutRow {
  account_name: string | null;
  account_number?: string | null;
  amount: number;
  approved_by?: string | null;
  bank_code?: string | null;
  batch_id?: string | null;
  completed_at?: string | null;
  created_at: string;
  currency: string;
  failure_code?: string | null;
  failure_message?: string | null;
  fee_minor: number;
  id: string;
  method: "mobile_money" | "bank";
  narration?: string | null;
  network: string | null;
  phone: string | null;
  provider_ref?: string | null;
  reference: string | null;
  status: string;
  total_hold_minor?: number;
}

interface PaymentLinkRow {
  active: boolean;
  amount: number | null;
  created_at: string;
  currency: string;
  id: string;
  link_url: string;
  reusable: boolean;
  slug: string;
  title: string;
}

interface MessageRow {
  cost_minor: number;
  created_at: string;
  id: string;
  preview: string;
  recipient: string;
  recipient_masked: string | null;
  segments: number;
  sender_id: string;
  status: "queued" | "sent" | "delivered" | "undelivered" | "failed" | "rejected";
  type: "transactional" | "otp" | "marketing";
}

interface BroadcastRow {
  accepted_count: number;
  body_preview: string;
  created_at: string;
  delivered_count: number;
  failed_count: number;
  id: string;
  pending_count: number;
  rejected_count: number;
  scheduled_at: string | null;
  sender_id: string | null;
  status: string;
  total_count: number;
  type: string;
}

interface AirtimeOrderRow {
  amount: number;
  batch_id: string | null;
  charge_amount: number;
  charge_currency: string;
  completed_at: string | null;
  country_code: string;
  created_at: string;
  currency: string;
  discount_minor: number;
  failure_code: string | null;
  fx_rate?: number | null;
  id: string;
  network: string;
  phone: string;
  phone_masked?: string;
  reference: string | null;
  status: "pending" | "processing" | "successful" | "failed";
}

interface AirtimeOrderDetail extends AirtimeOrderRow {
  event_timeline: Array<{
    created_at: string;
    from_status: string | null;
    provider_reference: string | null;
    reason: string | null;
    to_status: string;
  }>;
  fx_rate: number | null;
  phone_masked: string;
}

interface AirtimeBatchRow {
  accepted: number;
  charge_currency: string;
  completed_at: string | null;
  created_at: string;
  failed: number;
  id: string;
  reference: string | null;
  rejected: number;
  status: "processing" | "completed";
  successful: number;
  total_charge: number;
  total_items: number;
}

interface AirtimeSummaryData {
  failed: number;
  failed_today: number;
  pending: number;
  sent: number;
  sent_today: number;
  spend_minor: number;
  spent_this_month_minor: number;
  spent_today_minor: number;
  success_rate: number | null;
  successful: number;
  successful_today: number;
}

interface AirtimeQuoteData {
  amount: number;
  charge_amount: number;
  charge_currency: string;
  country_code: string;
  currency: string;
  discount_bps: number;
  discount_minor: number;
  fixed_denominations: number[] | null;
  fx_rate_id: string | null;
  max_amount: number;
  min_amount: number;
  network: string;
  phone: string;
}

interface CatalogProductRow {
  active: boolean;
  key: "airtime" | "collections" | "payouts" | "sms";
  requested: boolean;
}

interface AirtimeContactGroupRow {
  contact_count: number;
  id: string;
  name: string;
  phones: string[];
}

interface AirtimeNetworkRow {
  country_code: string;
  currency: string;
  discount_bps: number;
  fixed_denominations: number[] | null;
  max_amount: number;
  min_amount: number;
  network: string;
}

interface ContactRow {
  created_at: string;
  group_count: number;
  id: string;
  name: string | null;
  opted_out: boolean;
  phone: string;
  phone_masked: string | null;
  tags: string[];
}

interface ContactGroupRow {
  contact_count: number;
  created_at: string;
  id: string;
  name: string;
}

interface ContactsData {
  contacts: ContactRow[];
  groups: ContactGroupRow[];
  opt_out_count: number;
}

interface BalanceRow {
  amount_minor: number;
  currency: string;
  type: string;
}

interface StatementRow {
  account_type: string;
  amount_minor: number;
  created_at: string;
  currency: string;
  description: string;
  direction: string;
  id: string;
  reference_id: string | null;
  reference_type: string;
}

interface ApiKeyRow {
  created_at: string;
  created_by: string;
  expires_at: string | null;
  id: string;
  ip_allowlist: string[] | null;
  kind: string;
  last4: string;
  last_used_at: string | null;
  mode: MerchantMode;
  name: string;
  prefix: string;
  revoked_at: string | null;
  scopes: string[];
}

interface WebhookEndpointRow {
  consecutive_failures: number;
  created_at: string;
  description: string;
  enabled: boolean;
  events: string[];
  id: string;
  mode: MerchantMode;
  updated_at: string;
  url: string;
}

interface WebhookDeliveryRow {
  attempt: number;
  created_at: string;
  delivered_at: string | null;
  disabled_endpoint?: boolean;
  duration_ms: number | null;
  endpoint_consecutive_failures?: number;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  mode: MerchantMode;
  next_retry_at: string | null;
  response_snippet: string | null;
  status_code: number | null;
}

interface ApiRequestLogRow {
  created_at: string;
  duration_ms: number;
  method: string;
  path: string;
  request_body: unknown;
  request_id: string;
  response_body: unknown;
  status_code: number;
}

interface EventOutboxRow {
  created_at: string;
  id: string;
  mode: MerchantMode;
  payload: unknown;
  type: string;
}

interface SettlementAccountRow {
  created_at: string;
  details: Record<string, unknown>;
  id: string;
  is_default: boolean;
  type: "bank" | "mobile_money";
  verified_at: string | null;
}

interface TeamMemberRow {
  email: string | null;
  full_name: string | null;
  role: string;
  user_id: string;
}

interface SenderIdListData {
  items: Array<{
    approvals: Array<{
      country_code: string;
      created_at: string;
      id: string;
      network: string;
      rejection_reason: string | null;
      status: "pending" | "submitted" | "approved" | "rejected";
      updated_at: string;
      updated_by: string;
    }>;
    authorization_letter: string;
    created_at: string;
    created_by: string;
    id: string;
    overall_status: "approved" | "pending" | "rejected";
    purpose: "transactional" | "otp" | "marketing";
    sample_message: string;
    sender_id: string;
  }>;
  notifications: Array<{
    body: string;
    created_at: string;
    data: Record<string, unknown>;
    id: string;
    read_at: string | null;
    title: string;
    type: string;
  }>;
  summary: {
    approved: number;
    pending: number;
    rejected: number;
  };
}

const selectedMerchantStorageKey = "richespay_dashboard_merchant_id";
const webhookEventOptions = [
  { description: "Receive every event RichesPay sends for this merchant.", label: "All events", value: "*" },
  { description: "Collections that completed successfully.", label: "collection.successful", value: "collection.successful" },
  { description: "Collections that failed at the provider or validation layer.", label: "collection.failed", value: "collection.failed" },
  { description: "Collections that expired before final approval.", label: "collection.expired", value: "collection.expired" },
  { description: "Payouts that completed successfully.", label: "payout.successful", value: "payout.successful" },
  { description: "Payouts that failed or were rejected by a provider.", label: "payout.failed", value: "payout.failed" },
  { description: "Payout reversals and release events.", label: "payout.reversed", value: "payout.reversed" },
  { description: "Bulk payout batches that finished processing.", label: "payout_batch.completed", value: "payout_batch.completed" },
  { description: "SMS delivery confirmations.", label: "sms.delivered", value: "sms.delivered" },
  { description: "SMS delivery failures.", label: "sms.failed", value: "sms.failed" },
  { description: "Airtime top-ups that completed.", label: "airtime.successful", value: "airtime.successful" },
  { description: "Airtime top-ups that failed.", label: "airtime.failed", value: "airtime.failed" },
  { description: "Airtime batches that finished processing.", label: "airtime_batch.completed", value: "airtime_batch.completed" },
  { description: "Low balance alerts for funded products.", label: "balance.low", value: "balance.low" },
  { description: "Merchant collections freeze notifications.", label: "merchant.collections_frozen", value: "merchant.collections_frozen" },
  { description: "Merchant payouts freeze notifications.", label: "merchant.payouts_frozen", value: "merchant.payouts_frozen" },
  { description: "Webhook connectivity test event.", label: "webhook.test", value: "webhook.test" }
] as const;
const apiKeyScopeOptions = [
  { description: "Collections and checkout payments.", label: "Collections", value: "collections" },
  { description: "Single and bulk payouts.", label: "Payouts", value: "payouts" },
  { description: "SMS, bulk SMS, and OTP.", label: "SMS", value: "sms" },
  { description: "Single and bulk airtime top-ups.", label: "Airtime", value: "airtime" },
  { description: "Read-only balance and listing endpoints.", label: "Read", value: "read" }
] as const;
const httpMethodOptions = [
  { label: "All methods", value: "" },
  { label: "GET", value: "GET" },
  { label: "POST", value: "POST" },
  { label: "PUT", value: "PUT" },
  { label: "PATCH", value: "PATCH" },
  { label: "DELETE", value: "DELETE" }
] as const;
const statusClassOptions = [
  { label: "All status", value: "" },
  { label: "2xx", value: "2xx" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" }
] as const;

function makeDateRangeValue(): DateRangeValue {
  return { preset: "thirty_days" };
}

function formatDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone
  }).format(new Date(value));
}

function formatDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone
  }).format(new Date(value));
}

function dateRangeToQuery(value: DateRangeValue) {
  const today = new Date();
  const end = new Date(today);
  const start = new Date(today);

  switch (value.preset) {
    case "today":
      break;
    case "seven_days":
      start.setDate(today.getDate() - 6);
      break;
    case "this_month":
      start.setDate(1);
      break;
    case "custom":
      return {
        end_date: value.endDate,
        start_date: value.startDate
      };
    case "thirty_days":
    default:
      start.setDate(today.getDate() - 29);
      break;
  }

  return {
    end_date: end.toISOString().slice(0, 10),
    start_date: start.toISOString().slice(0, 10)
  };
}

function maskRecipient(phone: string) {
  if (phone.length <= 7) {
    return "***";
  }

  return `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}

function parseMajorAmount(value: string, currency: string) {
  try {
    const amount = toMinor(value.trim() === "" ? "0" : value.trim(), currency as CurrencyCode);
    return Number(amount);
  } catch {
    return Number.NaN;
  }
}

function parseAirtimeCsv(text: string, fallbackAmount: number | null) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"|"$/g, "")))
    .filter((cells) => cells.some((cell) => cell !== ""));

  if (rows.length > 0 && !/\d{4,}/.test(rows[0]?.[0] ?? "")) {
    rows.shift();
  }

  return rows.map((cells, index) => {
    const phone = (cells[0] ?? "").replace(/[^\d+]/g, "");
    const amountCell = cells[1] ?? "";
    const amount =
      amountCell !== ""
        ? Number(amountCell)
        : fallbackAmount ?? Number.NaN;
    const validPhone = /^\+\d{8,15}$/.test(phone);
    const validAmount = Number.isSafeInteger(amount) && amount > 0;

    return {
      amount,
      error: !validPhone
        ? "Invalid number"
        : !validAmount
          ? "Invalid amount"
          : null,
      index,
      phone,
      valid: validPhone && validAmount
    };
  });
}

function parseDelimitedRecipients(raw: string) {
  const normalized = raw
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));

  return unique.map((phone) => {
    const cleaned = phone.replace(/[^\d+]/g, "");
    const valid = /^\+\d{8,15}$/.test(cleaned);

    return {
      original: phone,
      phone: cleaned,
      valid
    };
  });
}

function exportCsv(fileName: string, headers: string[], rows: Array<Array<string | number | boolean | null>>) {
  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      row
        .map((value) => {
          const text = value === null ? "" : String(value);
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join(",")
    )
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function getStatusClass(statusCode: number | null) {
  if (statusCode === null) {
    return "-";
  }

  if (statusCode >= 500) {
    return "5xx";
  }

  if (statusCode >= 400) {
    return "4xx";
  }

  if (statusCode >= 200) {
    return "2xx";
  }

  return `${statusCode}`;
}

function ComplianceBanner({ session }: { session: SessionData }) {
  const banners = [
    session.compliance.status === "suspended"
      ? {
          label: "Merchant suspended",
          reason: session.compliance.suspension_reason,
          tone: "border-danger/30 bg-danger/10 text-danger"
        }
      : null,
    session.compliance.collections_frozen
      ? {
          label: "Collections frozen",
          reason: session.compliance.collections_freeze_reason,
          tone: "border-warning/40 bg-warning/10 text-amber-900"
        }
      : null,
    session.compliance.payouts_frozen
      ? {
          label: "Payouts frozen",
          reason: session.compliance.payouts_freeze_reason,
          tone: "border-warning/40 bg-warning/10 text-amber-900"
        }
      : null
  ].filter(Boolean);

  return (
    <>
      {banners.map((banner) =>
        banner ? (
          <div
            className={`rounded-card border px-4 py-3 text-sm ${banner.tone}`}
            key={banner.label}
          >
            <p className="font-semibold">{banner.label}</p>
            <p className="mt-1">
              {banner.reason ?? "RichesPay has applied a temporary control to this merchant."}
            </p>
            <a className="mt-2 inline-flex underline" href={session.compliance.contact_link}>
              Contact RichesPay compliance
            </a>
          </div>
        ) : null
      )}
    </>
  );
}

function MiniLineChart({
  points,
  currency
}: {
  currency: string;
  points: SummaryData["overview"]["chart"];
}) {
  if (points.length === 0) {
    return (
      <EmptyState
        description="Collections history will appear here once the first payments land."
        title="No collection history"
      />
    );
  }

  const maxValue = Math.max(...points.map((point) => point.collections_amount_minor), 1);
  const width = 640;
  const height = 220;
  const chartPath = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * (width - 24) + 12;
      const y =
        height - ((point.collections_amount_minor / maxValue) * (height - 32) + 16);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  const latest = points.at(-1)?.collections_amount_minor ?? 0;

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-text">Collections trend</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Latest: {formatMoney(BigInt(latest), currency as never, "en-GH")}
          </p>
        </div>
      </div>
      <div className="mt-5">
        <svg className="h-56 w-full" viewBox={`0 0 ${width} ${height}`}>
          <path
            d={chartPath}
            fill="none"
            stroke="rgb(var(--rp-brand-500))"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
        </svg>
      </div>
    </section>
  );
}

export function MerchantWorkspace({ auth }: { auth: WorkspaceAuth }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [selectedMerchantId, setSelectedMerchantId] = React.useState<string | null>(
    () => window.localStorage.getItem(selectedMerchantStorageKey)
  );
  const [dateRange, setDateRange] = React.useState<DateRangeValue>(makeDateRangeValue());
  const [developerDateRange, setDeveloperDateRange] = React.useState<DateRangeValue>(makeDateRangeValue());
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [methodFilter, setMethodFilter] = React.useState("");
  const [selectedCollectionId, setSelectedCollectionId] = React.useState<string | null>(null);
  const [selectedPayoutId, setSelectedPayoutId] = React.useState<string | null>(null);
  const [selectedPaymentLinkId, setSelectedPaymentLinkId] = React.useState<string | null>(null);
  const [selectedApiKeyId, setSelectedApiKeyId] = React.useState<string | null>(null);
  const [selectedWebhookId, setSelectedWebhookId] = React.useState<string | null>(null);
  const [selectedLogRequestId, setSelectedLogRequestId] = React.useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null);
  const [broadcastOpen, setBroadcastOpen] = React.useState(false);
  const [airtimeOpen, setAirtimeOpen] = React.useState(false);
  const [airtimeConfirmOpen, setAirtimeConfirmOpen] = React.useState(false);
  const [airtimeMode, setAirtimeMode] = React.useState<"single" | "bulk">("single");
  const [airtimePhone, setAirtimePhone] = React.useState("");
  const [airtimeAmount, setAirtimeAmount] = React.useState("10.00");
  const [airtimeReference, setAirtimeReference] = React.useState("");
  const [airtimePhonesText, setAirtimePhonesText] = React.useState("");
  const [airtimeCsv, setAirtimeCsv] = React.useState("");
  const [airtimeGroupId, setAirtimeGroupId] = React.useState("");
  const [airtimeSending, setAirtimeSending] = React.useState(false);
  const [airtimeNetworkFilter, setAirtimeNetworkFilter] = React.useState("");
  const [selectedAirtimeId, setSelectedAirtimeId] = React.useState<string | null>(null);
  const [selectedAirtimeBatchId, setSelectedAirtimeBatchId] = React.useState<string | null>(null);
  const [composeMessage, setComposeMessage] = React.useState("");
  const [composeSenderId, setComposeSenderId] = React.useState("");
  const [composeType, setComposeType] = React.useState("marketing");
  const [composeScheduleAt, setComposeScheduleAt] = React.useState("");
  const [composeRecipients, setComposeRecipients] = React.useState("");
  const [composeGroupId, setComposeGroupId] = React.useState("");
  const [composeUploadName, setComposeUploadName] = React.useState("");
  const [paymentLinkOpen, setPaymentLinkOpen] = React.useState(false);
  const [topupOpen, setTopupOpen] = React.useState(false);
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);
  const [contactImportOpen, setContactImportOpen] = React.useState(false);
  const [apiKeyOpen, setApiKeyOpen] = React.useState(false);
  const [webhookOpen, setWebhookOpen] = React.useState(false);
  const [senderIdRequestOpen, setSenderIdRequestOpen] = React.useState(false);
  const [newLinkTitle, setNewLinkTitle] = React.useState("");
  const [newLinkAmount, setNewLinkAmount] = React.useState("1000");
  const [newLinkResult, setNewLinkResult] = React.useState<PaymentLinkRow | null>(null);
  const [topupAmount, setTopupAmount] = React.useState("1000");
  const [topupMethod, setTopupMethod] = React.useState("bank_transfer");
  const [withdrawAmount, setWithdrawAmount] = React.useState("1000");
  const [withdrawAccountId, setWithdrawAccountId] = React.useState("");
  const [contactCsv, setContactCsv] = React.useState("");
  const [contactGroupName, setContactGroupName] = React.useState("");
  const [newApiKeyName, setNewApiKeyName] = React.useState("Dashboard key");
  const [newApiKeyMode, setNewApiKeyMode] = React.useState<MerchantMode>("test");
  const [apiKeyModeFilter, setApiKeyModeFilter] = React.useState("");
  const [newApiKeyIpAllowlist, setNewApiKeyIpAllowlist] = React.useState("");
  const [newApiKeyScopes, setNewApiKeyScopes] = React.useState<string[]>(["collections", "payouts", "sms", "airtime", "read"]);
  const [requestingProduct, setRequestingProduct] = React.useState<string | null>(null);
  const [creatingApiKey, setCreatingApiKey] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState("developer");
  const [inviting, setInviting] = React.useState(false);
  const [apiKeySecret, setApiKeySecret] = React.useState<{
    key: string;
    mode: MerchantMode;
    prefix: string;
    previousKeyExpiresAt?: string;
  } | null>(null);
  const [webhookSecret, setWebhookSecret] = React.useState<{
    endpointId: string;
    signingSecret: string;
    url: string;
  } | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = React.useState("");
  const [newWebhookEvents, setNewWebhookEvents] = React.useState<string[]>(["*"]);
  const [developerSearch, setDeveloperSearch] = React.useState("");
  const [logMethodFilter, setLogMethodFilter] = React.useState("");
  const [logStatusClass, setLogStatusClass] = React.useState("");
  const [eventTypeFilter, setEventTypeFilter] = React.useState("");
  const [senderIdValue, setSenderIdValue] = React.useState("");
  const [senderIdPurpose, setSenderIdPurpose] = React.useState("transactional");
  const [senderIdCountries, setSenderIdCountries] = React.useState("GH,ZM");
  const [senderIdSampleMessage, setSenderIdSampleMessage] = React.useState("");
  const [senderIdAuthorizationLetter, setSenderIdAuthorizationLetter] = React.useState("");

  const membershipsQuery = useQuery({
    enabled: Boolean(auth.accessToken),
    queryKey: ["dashboard-memberships", auth.accessToken],
    queryFn: () =>
      apiRequest<MembershipSummary[]>("/dashboard/v1/auth/memberships", {
        accessToken: auth.accessToken
      })
  });

  React.useEffect(() => {
    if (!selectedMerchantId && membershipsQuery.data?.[0]?.merchant_id) {
      setSelectedMerchantId(membershipsQuery.data[0].merchant_id);
    }
  }, [membershipsQuery.data, selectedMerchantId]);

  const sessionQuery = useQuery({
    enabled: Boolean(auth.accessToken && selectedMerchantId),
    queryKey: ["dashboard-session", auth.accessToken, selectedMerchantId],
    queryFn: () =>
      apiRequest<SessionData>("/dashboard/v1/session", {
        accessToken: auth.accessToken,
        merchantId: selectedMerchantId
      })
  });

  React.useEffect(() => {
    if (sessionQuery.data?.mode) {
      setNewApiKeyMode(sessionQuery.data.mode);
    }
  }, [sessionQuery.data?.mode]);

  const summaryQuery = useQuery({
    enabled: Boolean(auth.accessToken && selectedMerchantId),
    queryKey: ["dashboard-summary", auth.accessToken, selectedMerchantId, dateRange],
    queryFn: () =>
      apiRequest<SummaryData>(`/dashboard/v1/summary?${new URLSearchParams(
        Object.entries(dateRangeToQuery(dateRange)).filter((entry): entry is [string, string] => Boolean(entry[1]))
      ).toString()}`, {
        accessToken: auth.accessToken,
        merchantId: selectedMerchantId
      })
  });

  const session = sessionQuery.data;
  const currentPage = location.pathname.replace("/app", "") || "/overview";
  const merchantId = session?.merchant_id ?? selectedMerchantId ?? null;
  const timeZone = session?.timezone ?? "UTC";
  const currency = session?.settlement_currency ?? "GHS";

  const collectionsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/collections"),
    queryKey: ["dashboard-collections", auth.accessToken, merchantId, dateRange, search, statusFilter, methodFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      const dateQuery = dateRangeToQuery(dateRange);
      if (dateQuery.start_date) {
        params.set("created_gte", `${dateQuery.start_date}T00:00:00.000Z`);
      }
      if (dateQuery.end_date) {
        params.set("created_lte", `${dateQuery.end_date}T23:59:59.999Z`);
      }
      if (search) {
        params.set("search", search);
      }
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (methodFilter) {
        params.set("method", methodFilter);
      }
      return apiRequest<{ data: CollectionRow[]; meta: { next_starting_after: string | null } }>(
        `/dashboard/v1/collections?${params.toString()}`,
        {
          accessToken: auth.accessToken,
          merchantId
        }
      );
    }
  });

  const collectionDetailQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && selectedCollectionId),
    queryKey: ["dashboard-collection-detail", auth.accessToken, merchantId, selectedCollectionId],
    queryFn: () =>
      apiRequest<CollectionDetail>(`/dashboard/v1/collections/${selectedCollectionId}`, {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const payoutsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/payouts"),
    queryKey: ["dashboard-payouts", auth.accessToken, merchantId, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      return apiRequest<{ data: PayoutRow[] }>(`/dashboard/v1/payouts?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const payoutDetailQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && selectedPayoutId),
    queryKey: ["dashboard-payout-detail", auth.accessToken, merchantId, selectedPayoutId],
    queryFn: () =>
      apiRequest<PayoutRow>(`/dashboard/v1/payouts/${selectedPayoutId}`, {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const paymentLinksQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/payment-links"),
    queryKey: ["dashboard-payment-links", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<PaymentLinkRow[]>("/dashboard/v1/payment-links", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const messagesQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/messages"),
    queryKey: ["dashboard-messages", auth.accessToken, merchantId, dateRange, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      const dateQuery = dateRangeToQuery(dateRange);
      if (dateQuery.start_date) {
        params.set("created_gte", `${dateQuery.start_date}T00:00:00.000Z`);
      }
      if (dateQuery.end_date) {
        params.set("created_lte", `${dateQuery.end_date}T23:59:59.999Z`);
      }
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (composeSenderId) {
        params.set("sender_id", composeSenderId);
      }
      return apiRequest<{ data: MessageRow[] }>(`/dashboard/v1/messages?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const broadcastsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/messages"),
    queryKey: ["dashboard-broadcasts", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<{ data: BroadcastRow[] }>("/dashboard/v1/messages/batches", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const airtimeSummaryQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/airtime"),
    queryKey: ["dashboard-airtime-summary", auth.accessToken, merchantId, dateRange],
    queryFn: () => {
      const params = new URLSearchParams();
      const dateQuery = dateRangeToQuery(dateRange);
      if (dateQuery.start_date) {
        params.set("created_gte", `${dateQuery.start_date}T00:00:00.000Z`);
      }
      if (dateQuery.end_date) {
        params.set("created_lte", `${dateQuery.end_date}T23:59:59.999Z`);
      }
      return apiRequest<AirtimeSummaryData>(`/dashboard/v1/airtime/summary?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const airtimeNetworksQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && (currentPage === "/airtime" || airtimeOpen)),
    queryKey: ["dashboard-airtime-networks", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<AirtimeNetworkRow[]>("/dashboard/v1/airtime/networks", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const airtimeOrdersQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/airtime"),
    queryKey: ["dashboard-airtime-orders", auth.accessToken, merchantId, dateRange, search, statusFilter, airtimeNetworkFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      const dateQuery = dateRangeToQuery(dateRange);
      if (dateQuery.start_date) {
        params.set("created_gte", `${dateQuery.start_date}T00:00:00.000Z`);
      }
      if (dateQuery.end_date) {
        params.set("created_lte", `${dateQuery.end_date}T23:59:59.999Z`);
      }
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (airtimeNetworkFilter) {
        params.set("network", airtimeNetworkFilter);
      }
      if (search) {
        params.set("phone", search);
      }
      return apiRequest<AirtimeOrderRow[]>(
        `/dashboard/v1/airtime?${params.toString()}`,
        {
          accessToken: auth.accessToken,
          merchantId
        }
      );
    }
  });

  const airtimeBatchesQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/airtime"),
    queryKey: ["dashboard-airtime-batches", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<AirtimeBatchRow[]>("/dashboard/v1/airtime/batches", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const airtimeDetailQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && selectedAirtimeId),
    queryKey: ["dashboard-airtime-detail", auth.accessToken, merchantId, selectedAirtimeId],
    queryFn: () =>
      apiRequest<AirtimeOrderDetail>(`/dashboard/v1/airtime/${selectedAirtimeId}`, {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const airtimeGroupsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && airtimeOpen),
    queryKey: ["dashboard-airtime-groups", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<AirtimeContactGroupRow[]>("/dashboard/v1/airtime/contact-groups", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const productsCatalogQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/settings"),
    queryKey: ["dashboard-products", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<CatalogProductRow[]>("/dashboard/v1/products", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const airtimeAmountMinor = parseMajorAmount(airtimeAmount, currency);
  const airtimeQuoteQuery = useQuery({
    enabled: Boolean(
      auth.accessToken &&
        merchantId &&
        airtimeOpen &&
        airtimePhone.replace(/[^\d+]/g, "").length >= 8
    ),
    queryKey: [
      "dashboard-airtime-quote",
      auth.accessToken,
      merchantId,
      airtimePhone,
      Number.isSafeInteger(airtimeAmountMinor) ? airtimeAmountMinor : 0
    ],
    queryFn: () => {
      const params = new URLSearchParams({ phone: airtimePhone.trim() });
      if (Number.isSafeInteger(airtimeAmountMinor) && airtimeAmountMinor > 0) {
        params.set("amount", String(airtimeAmountMinor));
      }
      return apiRequest<AirtimeQuoteData>(`/dashboard/v1/airtime/quote?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    },
    retry: 0
  });

  const contactsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && (currentPage === "/contacts" || currentPage === "/messages")),
    queryKey: ["dashboard-contacts", auth.accessToken, merchantId, search],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) {
        params.set("search", search);
      }
      return apiRequest<ContactsData>(`/dashboard/v1/contacts?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const balanceQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/balance"),
    queryKey: ["dashboard-balance", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<BalanceRow[]>("/dashboard/v1/balance", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const statementQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/balance"),
    queryKey: ["dashboard-statement", auth.accessToken, merchantId, methodFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (methodFilter) {
        params.set("entry_type", methodFilter);
      }
      return apiRequest<StatementRow[]>(`/dashboard/v1/balance/statement?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const senderIdQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && session?.active_products.sms),
    queryKey: ["dashboard-sender-ids", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<SenderIdListData>("/dashboard/v1/sms/sender-ids", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const apiKeysQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/developers"),
    queryKey: ["dashboard-api-keys", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<ApiKeyRow[]>("/dashboard/v1/api-keys", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const webhooksQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/developers"),
    queryKey: ["dashboard-webhooks", auth.accessToken, merchantId, session?.mode],
    queryFn: () =>
      apiRequest<WebhookEndpointRow[]>("/dashboard/v1/webhooks", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const webhookDeliveriesQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/developers" && selectedWebhookId),
    queryKey: ["dashboard-webhook-deliveries", auth.accessToken, merchantId, selectedWebhookId],
    queryFn: () =>
      apiRequest<WebhookDeliveryRow[]>(
        `/dashboard/v1/webhooks/deliveries?${new URLSearchParams({ endpoint_id: selectedWebhookId!, limit: "20" }).toString()}`,
        {
          accessToken: auth.accessToken,
          merchantId
        }
      )
  });

  const apiRequestLogsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/developers"),
    queryKey: ["dashboard-api-request-logs", auth.accessToken, merchantId, developerDateRange, logMethodFilter, logStatusClass],
    queryFn: () => {
      const params = new URLSearchParams();
      const dateQuery = dateRangeToQuery(developerDateRange);
      if (dateQuery.start_date) {
        params.set("start_date", dateQuery.start_date);
      }
      if (dateQuery.end_date) {
        params.set("end_date", dateQuery.end_date);
      }
      if (logMethodFilter) {
        params.set("method", logMethodFilter);
      }
      if (logStatusClass) {
        params.set("status_class", logStatusClass);
      }
      params.set("limit", "50");

      return apiRequest<ApiRequestLogRow[]>(`/dashboard/v1/api-request-logs?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const eventsOutboxQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/developers"),
    queryKey: ["dashboard-events-outbox", auth.accessToken, merchantId, developerDateRange, eventTypeFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      const dateQuery = dateRangeToQuery(developerDateRange);
      if (dateQuery.start_date) {
        params.set("start_date", dateQuery.start_date);
      }
      if (dateQuery.end_date) {
        params.set("end_date", dateQuery.end_date);
      }
      if (eventTypeFilter) {
        params.set("type", eventTypeFilter);
      }
      params.set("limit", "50");

      return apiRequest<EventOutboxRow[]>(`/dashboard/v1/events-outbox?${params.toString()}`, {
        accessToken: auth.accessToken,
        merchantId
      });
    }
  });

  const teamQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/settings"),
    queryKey: ["dashboard-team", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<TeamMemberRow[]>("/dashboard/v1/team/members", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const settlementAccountsQuery = useQuery({
    enabled: Boolean(auth.accessToken && merchantId && currentPage === "/settings"),
    queryKey: ["dashboard-settlement-accounts", auth.accessToken, merchantId],
    queryFn: () =>
      apiRequest<SettlementAccountRow[]>("/dashboard/v1/settlement-accounts", {
        accessToken: auth.accessToken,
        merchantId
      })
  });

  const navSections = React.useMemo<SidebarSection[]>(() => {
    if (!session) {
      return [];
    }

    const sections: SidebarSection[] = [
      {
        label: "Overview",
        items: [{ href: "/app/overview", icon: <Activity className="size-4" />, label: "Overview" }]
      }
    ];

    if (session.active_products.collections || session.active_products.payouts) {
      sections.push({
        label: "Payments",
        items: [
          ...(session.active_products.collections
            ? [{ href: "/app/collections", icon: <CreditCard className="size-4" />, label: "Collections" }]
            : []),
          ...(session.active_products.payouts
            ? [{ href: "/app/payouts", icon: <Landmark className="size-4" />, label: "Payouts" }]
            : []),
          ...(session.active_products.collections
            ? [{ href: "/app/payment-links", icon: <Link2 className="size-4" />, label: "Payment links" }]
            : [])
        ]
      });
    }

    if (session.active_products.airtime) {
      sections.push({
        label: "Airtime",
        items: [{ href: "/app/airtime", icon: <Smartphone className="size-4" />, label: "Airtime" }]
      });
    }

    if (session.active_products.sms_broadcast || session.active_products.sms) {
      const messaging = [
        ...(session.active_products.sms_broadcast
          ? [
              { href: "/app/messages", icon: <MessageSquareText className="size-4" />, label: "Broadcast" },
              { href: "/app/contacts", icon: <Phone className="size-4" />, label: "Contacts" }
            ]
          : []),
        ...(session.active_products.sms_api || session.active_products.sms_broadcast
          ? [{ href: "/app/sender-ids", icon: <Send className="size-4" />, label: "Sender IDs" }]
          : [])
      ];

      if (messaging.length > 0) {
        sections.push({
          label: "Messaging",
          items: messaging
        });
      }
    }

    const operationItems = [
      { href: "/app/balance", icon: <CircleDollarSign className="size-4" />, label: "Balance" },
      ...(session.active_products.collections ||
      session.active_products.payouts ||
      session.active_products.sms_api ||
      session.active_products.airtime
        ? [{ href: "/app/developers", icon: <KeyRound className="size-4" />, label: "Developers" }]
        : []),
      { href: "/app/settings", icon: <Settings className="size-4" />, label: "Settings" }
    ];

    sections.push({
      label: "Operations",
      items: operationItems
    });

    return sections;
  }, [session]);

  const membershipOptions = (membershipsQuery.data ?? []).map((membership) => ({
    label: `${membership.merchant_name} (${membership.mode})`,
    value: membership.merchant_id
  }));

  const senderIdOptions = (senderIdQuery.data?.items ?? []).map((item) => ({
    label: item.sender_id,
    value: item.sender_id
  }));
  const groupOptions = (contactsQuery.data?.groups ?? []).map((group) => ({
    label: `${group.name} (${group.contact_count})`,
    value: group.id
  }));
  const settlementAccountOptions = (settlementAccountsQuery.data ?? []).map((account) => ({
    label: `${account.type === "bank" ? "Bank" : "Mobile money"}${account.is_default ? " (Default)" : ""}`,
    value: account.id
  }));
  const selectedPaymentLink =
    paymentLinksQuery.data?.find((row) => row.id === selectedPaymentLinkId) ?? null;
  const selectedApiKey =
    apiKeysQuery.data?.find((row) => row.id === selectedApiKeyId) ?? null;
  const selectedWebhook =
    webhooksQuery.data?.find((row) => row.id === selectedWebhookId) ?? null;
  const selectedRequestLog =
    apiRequestLogsQuery.data?.find((row) => row.request_id === selectedLogRequestId) ?? null;
  const selectedOutboxEvent =
    eventsOutboxQuery.data?.find((row) => row.id === selectedEventId) ?? null;
  const filteredApiKeys = React.useMemo(
    () =>
      (apiKeysQuery.data ?? []).filter((row) =>
        (apiKeyModeFilter ? row.mode === apiKeyModeFilter : true) &&
        (developerSearch
          ? `${row.name} ${row.prefix} ${row.mode} ${row.scopes.join(" ")}`
              .toLowerCase()
              .includes(developerSearch.toLowerCase())
          : true)
      ),
    [apiKeyModeFilter, apiKeysQuery.data, developerSearch]
  );
  const filteredWebhooks = React.useMemo(
    () =>
      (webhooksQuery.data ?? []).filter((row) =>
        developerSearch
          ? `${row.url} ${row.description} ${row.events.join(" ")}`
              .toLowerCase()
              .includes(developerSearch.toLowerCase())
          : true
      ),
    [developerSearch, webhooksQuery.data]
  );
  const filteredRequestLogs = React.useMemo(
    () =>
      (apiRequestLogsQuery.data ?? []).filter((row) =>
        developerSearch
          ? `${row.request_id} ${row.path} ${row.method}`
              .toLowerCase()
              .includes(developerSearch.toLowerCase())
          : true
      ),
    [apiRequestLogsQuery.data, developerSearch]
  );
  const filteredOutboxEvents = React.useMemo(
    () =>
      (eventsOutboxQuery.data ?? []).filter((row) =>
        developerSearch
          ? `${row.id} ${row.type}`.toLowerCase().includes(developerSearch.toLowerCase())
          : true
      ),
    [developerSearch, eventsOutboxQuery.data]
  );
  const eventTypeOptions = React.useMemo(
    () => [
      { label: "All event types", value: "" },
      ...(Array.from(new Set((eventsOutboxQuery.data ?? []).map((row) => row.type))).map((type) => ({
        label: type,
        value: type
      })))
    ],
    [eventsOutboxQuery.data]
  );
  const airtimePreviewRows = React.useMemo(() => {
    const selectedGroup = (airtimeGroupsQuery.data ?? []).find((group) => group.id === airtimeGroupId);
    if (airtimeCsv.trim()) {
      return parseAirtimeCsv(airtimeCsv, Number.isSafeInteger(airtimeAmountMinor) ? airtimeAmountMinor : null);
    }

    const phones = [
      ...parseDelimitedRecipients(airtimePhonesText).map((row) => row.phone),
      ...(selectedGroup?.phones ?? [])
    ];
    const unique = Array.from(new Set(phones.filter(Boolean)));
    return unique.map((phone, index) => {
      const validPhone = /^\+\d{8,15}$/.test(phone);
      const validAmount = Number.isSafeInteger(airtimeAmountMinor) && airtimeAmountMinor > 0;
      return {
        amount: airtimeAmountMinor,
        error: !validPhone ? "Invalid number" : !validAmount ? "Invalid amount" : null,
        index,
        phone,
        valid: validPhone && validAmount
      };
    });
  }, [airtimeAmountMinor, airtimeCsv, airtimeGroupId, airtimeGroupsQuery.data, airtimePhonesText]);

  const publicDocsUrl = new URL("/v1/openapi.pdf", env.apiBaseUrl).toString();
  const testSecretKeyPrefix =
    apiKeysQuery.data?.find(
      (row) => row.mode === "test" && row.kind === "secret" && !row.revoked_at
    )?.prefix ?? "rp_test_sk_";
  const quickStartCurl = React.useMemo(() => {
    const docsUrl = new URL("/v1/openapi.pdf", env.apiBaseUrl).toString();
    const authorization = `${testSecretKeyPrefix}<replace-with-secret>`;

    const airtimeCurl = `curl --request POST "${new URL("/v1/airtime", env.apiBaseUrl).toString()}" \\
  --header "Authorization: Bearer ${authorization}" \\
  --header "Idempotency-Key: reward-221" \\
  --header "Content-Type: application/json" \\
  --data '{
    "phone": "+260970000001",
    "amount": 1000,
    "currency": "ZMW",
    "reference": "REWARD-221"
  }'`;

    if (session?.active_products.collections) {
      const collectionsCurl = `curl --request POST "${new URL("/v1/collections", env.apiBaseUrl).toString()}" \\
  --header "Authorization: Bearer ${authorization}" \\
  --header "Idempotency-Key: demo-collection-0001" \\
  --header "Content-Type: application/json" \\
  --data '{
    "amount": 1500,
    "currency": "${currency}",
    "method": "mobile_money",
    "phone": "+233240000001",
    "reference": "demo-collection-0001",
    "description": "Quick start test payment"
  }'`;
      return `${session.active_products.airtime ? `${collectionsCurl}

# Send a test airtime top-up. Numbers ending in 0001 succeed.
${airtimeCurl}` : collectionsCurl}

# Public docs: ${docsUrl}`;
    }

    const withAirtime = (primary: string) =>
      session?.active_products.airtime
        ? `${primary}

# Send a test airtime top-up. Numbers ending in 0001 succeed.
${airtimeCurl}`
        : primary;

    if (session?.active_products.sms) {
      return `${withAirtime(`curl --request POST "${new URL("/v1/sms", env.apiBaseUrl).toString()}" \\
  --header "Authorization: Bearer ${authorization}" \\
  --header "Idempotency-Key: demo-sms-0001" \\
  --header "Content-Type: application/json" \\
  --data '{
    "to": "+233240000001",
    "message": "Hello from RichesPay test mode",
    "type": "transactional"
  }'`)}

# Public docs: ${docsUrl}`;
    }

    if (session?.active_products.payouts) {
      return `${withAirtime(`curl --request POST "${new URL("/v1/payouts", env.apiBaseUrl).toString()}" \\
  --header "Authorization: Bearer ${authorization}" \\
  --header "Idempotency-Key: demo-payout-0001" \\
  --header "Content-Type: application/json" \\
  --data '{
    "amount": 1500,
    "currency": "${currency}",
    "method": "mobile_money",
    "phone": "+233240000001",
    "reference": "demo-payout-0001"
  }'`)}

# Public docs: ${docsUrl}`;
    }

    if (session?.active_products.airtime) {
      return `${airtimeCurl}

# Public docs: ${docsUrl}`;
    }

    return `curl --request GET "${new URL("/v1/balance", env.apiBaseUrl).toString()}" \\
  --header "Authorization: Bearer ${authorization}"

# Public docs: ${docsUrl}`;
  }, [currency, session?.active_products.airtime, session?.active_products.collections, session?.active_products.payouts, session?.active_products.sms, testSecretKeyPrefix]);

  const recipientRows = parseDelimitedRecipients(composeRecipients);
  const validRecipientRows = recipientRows.filter((row) => row.valid);
  const invalidRecipientRows = recipientRows.filter((row) => !row.valid);
  const estimatedSegments = composeMessage ? Math.max(1, Math.ceil(composeMessage.length / 160)) : 0;
  const estimatedCost =
    estimatedSegments * validRecipientRows.length * Math.max(Math.round((summaryQuery.data?.messages.spend_minor ?? 5) / Math.max(summaryQuery.data?.messages.sent ?? 1, 1)), 1);

  async function handleBroadcastSend() {
    if (!auth.accessToken || !merchantId) {
      return;
    }

    try {
      await apiRequest<unknown>("/dashboard/v1/messages/broadcast", {
        accessToken: auth.accessToken,
        body: JSON.stringify({
          ...(composeGroupId ? { contact_group_id: composeGroupId } : {}),
          ...(validRecipientRows.length > 0
            ? {
                recipients: validRecipientRows.map((row) => ({
                  phone: row.phone
                }))
              }
            : {}),
          ...(composeScheduleAt ? { schedule_at: new Date(composeScheduleAt).toISOString() } : {}),
          ...(composeSenderId ? { sender_id: composeSenderId } : {}),
          message: composeMessage,
          type: composeType,
          upload_name: composeUploadName || undefined
        }),
        merchantId,
        method: "POST"
      });

      setBroadcastOpen(false);
      setComposeMessage("");
      setComposeRecipients("");
      setComposeScheduleAt("");
      setComposeGroupId("");
      pushToast({
        title: "Broadcast queued",
        description: "Your SMS broadcast is now queued for delivery.",
        variant: "success"
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard-messages"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-broadcasts"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
      ]);
    } catch (error) {
      pushToast({
        title: "Broadcast failed",
        description: error instanceof ApiError ? error.message : "Unable to queue the broadcast.",
        variant: "danger"
      });
    }
  }

  async function handleAirtimeSend() {
    if (!auth.accessToken || !merchantId || airtimeSending) {
      return;
    }

    const singleAmount = airtimeQuoteQuery.data?.amount ?? airtimeAmountMinor;
    const validBulk = airtimePreviewRows.filter((row) => row.valid);
    const sendingBulk = airtimeMode === "bulk";

    if (!sendingBulk && (!airtimePhone.trim() || !Number.isSafeInteger(singleAmount) || singleAmount <= 0)) {
      pushToast({
        title: "Send airtime failed",
        description: "Enter a valid phone number and amount.",
        variant: "danger"
      });
      return;
    }

    if (sendingBulk && validBulk.length === 0) {
      pushToast({
        title: "Send airtime failed",
        description: "Add at least one valid recipient.",
        variant: "danger"
      });
      return;
    }

    setAirtimeSending(true);
    try {
      const idempotencyKey =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `airtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      if (!sendingBulk) {
        await apiRequest<AirtimeOrderRow>("/dashboard/v1/airtime", {
          accessToken: auth.accessToken,
          body: JSON.stringify({
            amount: singleAmount,
            currency: airtimeQuoteQuery.data?.currency ?? currency,
            phone: airtimePhone.trim(),
            ...(airtimeReference.trim() ? { reference: airtimeReference.trim() } : {})
          }),
          headers: { "Idempotency-Key": idempotencyKey },
          merchantId,
          method: "POST"
        });
      } else {
        await apiRequest<unknown>("/dashboard/v1/airtime/bulk", {
          accessToken: auth.accessToken,
          body: JSON.stringify({
            ...(airtimeCsv.trim()
              ? { csv: airtimeCsv }
              : {
                  amount: airtimeAmountMinor,
                  currency: airtimeQuoteQuery.data?.currency ?? currency,
                  phones_text: validBulk.map((row) => row.phone).join("\n")
                }),
            ...(airtimeReference.trim() ? { reference: airtimeReference.trim() } : {})
          }),
          headers: { "Idempotency-Key": idempotencyKey },
          merchantId,
          method: "POST"
        });
      }

      setAirtimeOpen(false);
      setAirtimeConfirmOpen(false);
      setAirtimePhone("");
      setAirtimePhonesText("");
      setAirtimeCsv("");
      setAirtimeGroupId("");
      setAirtimeReference("");
      pushToast({
        title: "Airtime queued",
        description: sendingBulk ? "The bulk top-up batch is now processing." : "The top-up is now processing.",
        variant: "success"
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard-airtime-orders"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-airtime-batches"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-airtime-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
      ]);
    } catch (error) {
      pushToast({
        title: "Send airtime failed",
        description: error instanceof ApiError ? error.message : "Unable to send airtime.",
        variant: "danger"
      });
    } finally {
      setAirtimeSending(false);
    }
  }

  async function handleProductRequest(product: CatalogProductRow["key"]) {
    if (!auth.accessToken || !merchantId || requestingProduct) {
      return;
    }

    setRequestingProduct(product);
    try {
      await apiRequest("/dashboard/v1/products/request", {
        accessToken: auth.accessToken,
        body: JSON.stringify({ product }),
        merchantId,
        method: "POST"
      });
      pushToast({
        description: "RichesPay will review this product the same way as your other products.",
        title: "Product requested",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-products"] });
    } catch (error) {
      pushToast({
        description: error instanceof ApiError ? error.message : "Unable to request this product.",
        title: "Request failed",
        variant: "danger"
      });
    } finally {
      setRequestingProduct(null);
    }
  }

  const validAirtimeRows = airtimePreviewRows.filter((row) => row.valid);
  const airtimeFaceTotal =
    airtimeMode === "single"
      ? (airtimeQuoteQuery.data?.amount ?? (Number.isSafeInteger(airtimeAmountMinor) ? airtimeAmountMinor : 0))
      : validAirtimeRows.reduce((sum, row) => sum + row.amount, 0);
  const airtimeUnitCharge = airtimeQuoteQuery.data?.charge_amount ?? 0;
  const airtimeUnitFace = airtimeQuoteQuery.data?.amount || airtimeAmountMinor || 1;
  const airtimeCostTotal =
    airtimeMode === "single"
      ? airtimeUnitCharge
      : Math.round(
          validAirtimeRows.reduce(
            (sum, row) => sum + (row.amount * airtimeUnitCharge) / airtimeUnitFace,
            0
          )
        );
  const airtimeBalance = summaryQuery.data?.balance.available_minor ?? 0;
  const airtimeBalanceAfter = airtimeBalance - airtimeCostTotal;
  const airtimeBalanceTooLow = airtimeCostTotal > 0 && airtimeBalanceAfter < 0;
  const airtimeQuoteNetwork = airtimeQuoteQuery.data;
  const airtimeFixedDenoms = airtimeQuoteNetwork?.fixed_denominations ?? [];

  async function handleSharePaymentLink(link: PaymentLinkRow) {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: link.title,
          text: `Pay ${link.title} with RichesPay`,
          url: link.link_url
        });
        return;
      } catch {
        // Fall through to clipboard copy when native sharing is dismissed or unavailable.
      }
    }

    await navigator.clipboard.writeText(link.link_url);
    pushToast({
      title: "Link copied",
      description: "The payment link URL is ready to share.",
      variant: "success"
    });
  }

  async function handleApprovePayout() {
    if (!auth.accessToken || !merchantId || !selectedPayoutId) {
      return;
    }

    try {
      await apiRequest(`/dashboard/v1/payouts/${selectedPayoutId}/approve`, {
        accessToken: auth.accessToken,
        merchantId,
        method: "POST"
      });
      pushToast({
        title: "Payout approved",
        description: "The payout is now queued for processing.",
        variant: "success"
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard-payouts"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-payout-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
      ]);
    } catch (error) {
      pushToast({
        title: "Approval failed",
        description: error instanceof ApiError ? error.message : "Unable to approve the payout.",
        variant: "danger"
      });
    }
  }

  async function handleCreateSenderId() {
    if (!auth.accessToken || !merchantId) {
      return;
    }

    try {
      await apiRequest("/dashboard/v1/sms/sender-ids", {
        accessToken: auth.accessToken,
        body: JSON.stringify({
          authorization_letter_path: senderIdAuthorizationLetter,
          countries: senderIdCountries
            .split(",")
            .map((value) => value.trim().toUpperCase())
            .filter(Boolean),
          purpose: senderIdPurpose,
          sample_message: senderIdSampleMessage,
          sender_id: senderIdValue
        }),
        merchantId,
        method: "POST"
      });

      setSenderIdRequestOpen(false);
      setSenderIdValue("");
      setSenderIdSampleMessage("");
      setSenderIdAuthorizationLetter("");
      setSenderIdCountries("GH,ZM");
      pushToast({
        title: "Sender ID requested",
        description: "The request has been submitted for review.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sender-ids"] });
    } catch (error) {
      pushToast({
        title: "Request failed",
        description: error instanceof ApiError ? error.message : "Unable to request the sender ID.",
        variant: "danger"
      });
    }
  }

  function toggleApiKeyScope(scope: string) {
    setNewApiKeyScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope]
    );
  }

  function toggleWebhookEvent(eventName: string) {
    setNewWebhookEvents((current) => {
      if (eventName === "*") {
        return current.includes("*") ? [] : ["*"];
      }

      const withoutWildcard = current.filter((item) => item !== "*");
      return withoutWildcard.includes(eventName)
        ? withoutWildcard.filter((item) => item !== eventName)
        : [...withoutWildcard, eventName];
    });
  }

  async function handleCreateApiKey() {
    if (!auth.accessToken || !merchantId || newApiKeyScopes.length === 0 || creatingApiKey) {
      return;
    }

    setCreatingApiKey(true);
    try {
      const created = await apiRequest<ApiKeyRow & { key: string }>("/dashboard/v1/api-keys", {
        accessToken: auth.accessToken,
        body: JSON.stringify({
          ip_allowlist: newApiKeyIpAllowlist
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          kind: "secret",
          mode: newApiKeyMode,
          name: newApiKeyName,
          scopes: newApiKeyScopes
        }),
        merchantId,
        method: "POST"
      });

      setApiKeyOpen(false);
      setApiKeySecret({
        key: created.key,
        mode: created.mode,
        prefix: created.prefix
      });
      setNewApiKeyIpAllowlist("");
      pushToast({
        title: "API key created",
        description: "Copy the secret now. It will only be shown once.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-api-keys"] });
    } catch (error) {
      pushToast({
        title: "Create key failed",
        description: error instanceof ApiError ? error.message : "Unable to create the API key.",
        variant: "danger"
      });
    } finally {
      setCreatingApiKey(false);
    }
  }

  async function handleRollApiKey() {
    if (!auth.accessToken || !merchantId || !selectedApiKey) {
      return;
    }

    try {
      const rolled = await apiRequest<ApiKeyRow & { key: string; previous_key_expires_at: string }>(
        `/dashboard/v1/api-keys/${selectedApiKey.id}/roll`,
        {
          accessToken: auth.accessToken,
          merchantId,
          method: "POST"
        }
      );

      setApiKeySecret({
        key: rolled.key,
        mode: rolled.mode,
        prefix: rolled.prefix,
        previousKeyExpiresAt: rolled.previous_key_expires_at
      });
      pushToast({
        title: "API key rolled",
        description: "The previous key remains valid during the grace window.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-api-keys"] });
    } catch (error) {
      pushToast({
        title: "Roll failed",
        description: error instanceof ApiError ? error.message : "Unable to roll the API key.",
        variant: "danger"
      });
    }
  }

  async function handleRevokeApiKey() {
    if (!auth.accessToken || !merchantId || !selectedApiKey) {
      return;
    }

    try {
      await apiRequest(`/dashboard/v1/api-keys/${selectedApiKey.id}/revoke`, {
        accessToken: auth.accessToken,
        merchantId,
        method: "POST"
      });
      pushToast({
        title: "API key revoked",
        description: "The key can no longer be used for API calls.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-api-keys"] });
    } catch (error) {
      pushToast({
        title: "Revoke failed",
        description: error instanceof ApiError ? error.message : "Unable to revoke the API key.",
        variant: "danger"
      });
    }
  }

  async function handleCreateWebhook() {
    if (!auth.accessToken || !merchantId || newWebhookEvents.length === 0) {
      return;
    }

    try {
      const created = await apiRequest<{
        endpoint: WebhookEndpointRow;
        signing_secret: string;
      }>("/dashboard/v1/webhooks", {
        accessToken: auth.accessToken,
        body: JSON.stringify({
          description: new URL(newWebhookUrl).hostname,
          enabled: true,
          events: newWebhookEvents,
          url: newWebhookUrl
        }),
        merchantId,
        method: "POST"
      });

      setWebhookOpen(false);
      setWebhookSecret({
        endpointId: created.endpoint.id,
        signingSecret: created.signing_secret,
        url: created.endpoint.url
      });
      setNewWebhookUrl("");
      setNewWebhookEvents(["*"]);
      pushToast({
        title: "Webhook endpoint added",
        description: "Copy the signing secret now. It will not be shown again.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-webhooks"] });
    } catch (error) {
      pushToast({
        title: "Webhook failed",
        description: error instanceof ApiError ? error.message : "Unable to create the endpoint.",
        variant: "danger"
      });
    }
  }

  async function handleSendTestWebhook(endpointId: string) {
    if (!auth.accessToken || !merchantId) {
      return;
    }

    try {
      await apiRequest<WebhookDeliveryRow>(`/dashboard/v1/webhooks/${endpointId}/test`, {
        accessToken: auth.accessToken,
        merchantId,
        method: "POST"
      });
      pushToast({
        title: "Test event sent",
        description: "A webhook test event was queued for delivery.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-webhook-deliveries"] });
    } catch (error) {
      pushToast({
        title: "Test send failed",
        description: error instanceof ApiError ? error.message : "Unable to send the test event.",
        variant: "danger"
      });
    }
  }

  async function handleReplayWebhookDelivery(delivery: WebhookDeliveryRow) {
    if (!auth.accessToken || !merchantId) {
      return;
    }

    try {
      await apiRequest<WebhookDeliveryRow>(
        `/dashboard/v1/webhooks/${delivery.endpoint_id}/deliveries/${delivery.event_id}/replay`,
        {
          accessToken: auth.accessToken,
          merchantId,
          method: "POST"
        }
      );
      pushToast({
        title: "Delivery replayed",
        description: "A new delivery attempt has been queued.",
        variant: "success"
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-webhook-deliveries"] });
    } catch (error) {
      pushToast({
        title: "Replay failed",
        description: error instanceof ApiError ? error.message : "Unable to replay the delivery.",
        variant: "danger"
      });
    }
  }

  const sessionError = sessionQuery.error;
  const membershipsError = membershipsQuery.error;
  const mfaRequired = sessionError instanceof ApiError && sessionError.code === "mfa_required";
  const accessPending = membershipsQuery.isLoading || sessionQuery.isLoading || mfaRequired;
  const [accessWaitExpired, setAccessWaitExpired] = React.useState(false);

  React.useEffect(() => {
    if (!mfaRequired) {
      return;
    }

    void supabase.auth.mfa.listFactors().then(({ data }) => {
      const verified = data?.totp.some((factor) => factor.status === "verified");
      window.location.assign(verified ? "/enter-2fa" : "/setup-2fa");
    });
  }, [mfaRequired]);

  React.useEffect(() => {
    if (!accessPending) {
      setAccessWaitExpired(false);
      return;
    }

    const timer = window.setTimeout(() => setAccessWaitExpired(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [accessPending]);

  function escapeActions() {
    return (
      <div className="flex flex-wrap justify-center gap-3">
        <Button
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ["dashboard-memberships"] });
            void queryClient.invalidateQueries({ queryKey: ["dashboard-session"] });
          }}
          variant="primary"
        >
          Try again
        </Button>
        <Button onClick={() => void auth.signOutEverywhere()} variant="secondary">
          Sign out
        </Button>
      </div>
    );
  }

  if (accessPending) {
    return (
      <div className="p-8">
        <EmptyState
          action={accessWaitExpired ? escapeActions() : undefined}
          description={
            mfaRequired
              ? "Merchant owners need an authenticator code before the workspace opens."
              : "Checking your merchant access."
          }
          title={mfaRequired ? "Set up two-factor authentication" : "One moment"}
        />
      </div>
    );
  }

  if (membershipsError) {
    return (
      <div className="p-8">
        <EmptyState
          action={escapeActions()}
          description={
            membershipsError instanceof ApiError
              ? membershipsError.message
              : "The merchant list could not be loaded."
          }
          title="Merchant access unavailable"
        />
      </div>
    );
  }

  if (!membershipsQuery.data?.length) {
    return (
      <div className="p-8">
        <EmptyState
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Link to="/sign-up">
                <Button variant="primary">Create merchant</Button>
              </Link>
              <Link to="/accept-invite">
                <Button variant="secondary">Accept invite</Button>
              </Link>
              <Button onClick={() => void auth.signOutEverywhere()} variant="secondary">
                Sign out
              </Button>
            </div>
          }
          description="This login is not a member of a merchant. Sign in with the account that created the business, create a merchant, or open an invitation link."
          title="No merchant access yet"
        />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-8">
        <EmptyState
          action={escapeActions()}
          description={
            sessionError instanceof ApiError
              ? sessionError.message
              : "The merchant session could not be loaded."
          }
          title="Merchant session unavailable"
        />
      </div>
    );
  }

  return (
    <>
      <AppShell
        activePath={location.pathname}
        liveAccessEnabled={(membershipsQuery.data ?? []).some(
          (membership) =>
            membership.mode === "live" && membership.merchant_name === session.merchant_name
        )}
        mode={session.mode}
        navSections={navSections}
        onModeChange={(mode) => {
          if (mode === session.mode) {
            return;
          }

          const alternative = (membershipsQuery.data ?? []).find(
            (membership) =>
              membership.mode === mode &&
              membership.merchant_name === session.merchant_name
          );

          if (!alternative) {
            pushToast({
              title: mode === "live" ? "Live access is locked" : "Test mode is unavailable",
              description:
                mode === "live"
                  ? "Finish KYB and wait for approval before live money movement."
                  : "This merchant does not have a sandbox account.",
              variant: "warning"
            });
            return;
          }

          setSelectedMerchantId(alternative.merchant_id);
          window.localStorage.setItem(selectedMerchantStorageKey, alternative.merchant_id);
        }}
        title="RichesPay Dashboard"
        topBarContent={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Select
              onValueChange={(value) => {
                setSelectedMerchantId(value);
                window.localStorage.setItem(selectedMerchantStorageKey, value);
              }}
              options={membershipOptions}
              value={selectedMerchantId ?? undefined}
            />
            <Button
              onClick={() => {
                void auth.signOutEverywhere();
              }}
              variant="secondary"
            >
              Sign out everywhere
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <ComplianceBanner session={session} />

          {currentPage === "/overview" ? (
            <>
              <PageHeader
                subtitle="Fast merchant KPIs, recent activity, and the next setup steps based on the products active on this merchant."
                title="Overview"
              />
              <SummaryCardGrid columns={4}>
                <SummaryCard
                  icon={<CircleDollarSign className="size-4" />}
                  label="Available balance"
                  value={<MoneyText amountMinor={BigInt(summaryQuery.data?.overview.cards.available_balance_minor ?? 0)} currency={currency as never} />}
                />
                {session.active_products.airtime &&
                !session.active_products.collections &&
                !session.active_products.payouts &&
                !session.active_products.sms ? (
                  <>
                    <SummaryCard
                      icon={<Smartphone className="size-4" />}
                      label="Airtime sent today"
                      value={summaryQuery.data?.overview.cards.airtime_sent_today ?? 0}
                    />
                    <SummaryCard
                      icon={<Activity className="size-4" />}
                      label="Success rate"
                      value={`${summaryQuery.data?.overview.cards.airtime_success_rate ?? 0}%`}
                    />
                    <SummaryCard
                      icon={<CircleDollarSign className="size-4" />}
                      label="Spend this month"
                      value={<MoneyText amountMinor={BigInt(summaryQuery.data?.overview.cards.airtime_spend_this_month_minor ?? 0)} currency={currency as never} />}
                    />
                  </>
                ) : (
                  <>
                    {session.active_products.collections ? (
                      <SummaryCard
                        icon={<CreditCard className="size-4" />}
                        label="Collected today"
                        value={<MoneyText amountMinor={BigInt(summaryQuery.data?.overview.cards.collected_today_minor ?? 0)} currency={currency as never} />}
                      />
                    ) : null}
                    {session.active_products.payouts ? (
                      <SummaryCard
                        icon={<Landmark className="size-4" />}
                        label="Paid out today"
                        value={<MoneyText amountMinor={BigInt(summaryQuery.data?.overview.cards.paid_out_today_minor ?? 0)} currency={currency as never} />}
                      />
                    ) : null}
                    {session.active_products.sms ? (
                      <SummaryCard
                        icon={<MessageSquareText className="size-4" />}
                        label="SMS sent today"
                        value={summaryQuery.data?.overview.cards.sms_sent_today ?? 0}
                      />
                    ) : null}
                    {session.active_products.airtime ? (
                      <SummaryCard
                        icon={<Smartphone className="size-4" />}
                        label="Airtime sent today"
                        value={summaryQuery.data?.overview.cards.airtime_sent_today ?? 0}
                      />
                    ) : null}
                  </>
                )}
              </SummaryCardGrid>
              <FilterBar
                filters={[
                  <DateRangePicker key="range" onChange={setDateRange} value={dateRange} />
                ]}
                onReset={() => setDateRange(makeDateRangeValue())}
              />
              <MiniLineChart
                currency={currency}
                points={summaryQuery.data?.overview.chart ?? []}
              />
              <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                <h3 className="text-lg font-semibold text-text">Get started</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {(summaryQuery.data?.overview.checklist ?? []).map((item) => (
                    <div
                      className="flex items-center gap-3 rounded-input border border-border bg-surface-subtle px-4 py-3"
                      key={item.key}
                    >
                      <div className={`size-3 rounded-full ${item.complete ? "bg-success" : "bg-border-strong"}`} />
                      <span className="text-sm text-text">{item.label}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-text">Last 8 transactions</h3>
                  <Button
                    onClick={() =>
                      exportCsv(
                        "recent-transactions.csv",
                        ["ID", "Kind", "Reference", "Amount", "Currency", "Status", "Created at"],
                        (summaryQuery.data?.overview.recent_transactions ?? []).map((row) => [
                          row.id,
                          row.kind,
                          row.reference,
                          row.amount_minor,
                          row.currency,
                          row.status,
                          row.created_at
                        ])
                      )
                    }
                    variant="ghost"
                  >
                    <Download className="size-4" />
                    Export CSV
                  </Button>
                </div>
                <div className="mt-4 space-y-3">
                  {(summaryQuery.data?.overview.recent_transactions ?? []).map((item) => (
                    <div
                      className="flex flex-col gap-2 rounded-input border border-border bg-surface-subtle px-4 py-3 md:flex-row md:items-center md:justify-between"
                      key={item.id}
                    >
                      <div>
                        <p className="font-medium text-text">{item.reference ?? item.id}</p>
                        <p className="text-sm text-text-secondary">{item.kind}</p>
                      </div>
                      <div className="text-sm text-text-secondary">{formatDateTime(item.created_at, timeZone)}</div>
                      <div className="font-medium text-text">
                        {formatMoney(BigInt(item.amount_minor), item.currency as never, "en-GH")}
                      </div>
                      <StatusBadge status={(item.status === "successful" ? "successful" : item.status === "delivered" ? "delivered" : item.status === "failed" ? "failed" : item.status === "pending" || item.status === "processing" ? "processing" : "pending") as never} />
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {currentPage === "/collections" ? (
            <>
              <PageHeader subtitle="Track collection performance, filter by status and method, and inspect transaction timelines." title="Collections" />
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Total collected" value={<MoneyText amountMinor={BigInt(summaryQuery.data?.collections.total_collected_minor ?? 0)} currency={currency as never} />} />
                <SummaryCard icon={<CreditCard className="size-4" />} label="Successful" value={summaryQuery.data?.collections.successful ?? 0} />
                <SummaryCard icon={<Activity className="size-4" />} label="Success rate" value={`${summaryQuery.data?.collections.success_rate ?? 0}%`} />
                <SummaryCard icon={<BookText className="size-4" />} label="Pending" value={summaryQuery.data?.collections.pending ?? 0} />
              </SummaryCardGrid>
              <FilterBar
                filters={[
                  <DateRangePicker key="range" onChange={setDateRange} value={dateRange} />,
                  <Select key="status" onValueChange={setStatusFilter} options={[{ label: "All statuses", value: "" }, { label: "Pending", value: "pending" }, { label: "Processing", value: "processing" }, { label: "Successful", value: "successful" }, { label: "Failed", value: "failed" }]} value={statusFilter} />,
                  <Select key="method" onValueChange={setMethodFilter} options={[{ label: "All methods", value: "" }, { label: "Mobile money", value: "mobile_money" }, { label: "Card", value: "card" }]} value={methodFilter} />
                ]}
                onReset={() => {
                  setDateRange(makeDateRangeValue());
                  setStatusFilter("");
                  setMethodFilter("");
                  setSearch("");
                }}
                onSearchChange={setSearch}
                searchValue={search}
              />
              <DataTable
                columns={([
                  { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                  { accessorKey: "reference", header: "Reference", cell: ({ row }) => row.original.reference ?? row.original.id },
                  { accessorKey: "customer", header: "Customer", cell: ({ row }) => row.original.customer.phone_masked ?? "-" },
                  { accessorKey: "method", header: "Method", cell: ({ row }) => `${row.original.method}${row.original.network ? ` / ${row.original.network}` : ""}` },
                  { accessorKey: "amount", header: "Amount", cell: ({ row }) => formatMoney(BigInt(row.original.amount), row.original.currency as never, "en-GH") },
                  { accessorKey: "fee_minor", header: "Fee", cell: ({ row }) => formatMoney(BigInt(row.original.fee_minor), row.original.currency as never, "en-GH") },
                  { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.status === "successful" ? "successful" : row.original.status === "failed" ? "failed" : row.original.status === "processing" ? "processing" : row.original.status === "reversed" ? "reversed" : row.original.status === "expired" ? "expired" : "pending") as never} /> }
                ] as ColumnDef<CollectionRow>[]) }
                data={collectionsQuery.data?.data ?? []}
                emptyState={<EmptyState description="Collections will appear here once the merchant starts accepting payments." title="No collections yet" />}
                loading={collectionsQuery.isLoading}
                onRowClick={(row) => setSelectedCollectionId(row.id)}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
              />
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedCollectionId(null);
                  }
                }}
                open={Boolean(selectedCollectionId)}
                title="Collection details"
              >
                {collectionDetailQuery.data ? (
                  <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Gross</p>
                        <p className="mt-1 font-semibold text-text">{formatMoney(BigInt(collectionDetailQuery.data.amount_breakdown.gross_minor), currency as never, "en-GH")}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Fee</p>
                        <p className="mt-1 font-semibold text-text">{formatMoney(BigInt(collectionDetailQuery.data.amount_breakdown.fee_minor), currency as never, "en-GH")}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Net</p>
                        <p className="mt-1 font-semibold text-text">{formatMoney(BigInt(collectionDetailQuery.data.amount_breakdown.net_minor), currency as never, "en-GH")}</p>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <h4 className="font-semibold text-text">Event timeline</h4>
                      {collectionDetailQuery.data.event_timeline.map((event, index) => (
                        <div className="rounded-input border border-border bg-surface-subtle px-4 py-3" key={`${event.created_at}-${index}`}>
                          <p className="font-medium text-text">{event.from_status ?? "start"} to {event.to_status}</p>
                          <p className="text-sm text-text-secondary">{formatDateTime(event.created_at, timeZone)}</p>
                          {event.reason ? <p className="mt-1 text-sm text-text-secondary">{event.reason}</p> : null}
                        </div>
                      ))}
                    </div>
                    <ConfirmDialog
                      confirmLabel="Request refund"
                      description="This sends a full refund request for the selected collection."
                      onConfirm={async () => {
                        pushToast({
                          title: "Refund action not wired",
                          description: "The drawer is ready, but the refund submission flow still needs a dashboard endpoint.",
                          variant: "warning"
                        });
                      }}
                      title="Refund collection"
                      trigger={<Button variant="secondary">Refund</Button>}
                    >
                      <p className="text-sm text-text-secondary">Refunds are available for successful collections only.</p>
                    </ConfirmDialog>
                  </div>
                ) : null}
              </Drawer>
            </>
          ) : null}

          {currentPage === "/payouts" ? (
            <>
              <PageHeader subtitle="Single and bulk payouts, approvals, and payout outcomes." title="Payouts" />
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Paid out" value={<MoneyText amountMinor={BigInt(summaryQuery.data?.payouts.paid_out_minor ?? 0)} currency={currency as never} />} />
                <SummaryCard icon={<Landmark className="size-4" />} label="Successful" value={summaryQuery.data?.payouts.successful ?? 0} />
                <SummaryCard icon={<Activity className="size-4" />} label="Failed" value={summaryQuery.data?.payouts.failed ?? 0} />
                <SummaryCard icon={<ShieldCheck className="size-4" />} label="Awaiting approval" value={summaryQuery.data?.payouts.awaiting_approval ?? 0} />
              </SummaryCardGrid>
              <PageHeader
                action={
                  <div className="flex gap-3">
                    <Button onClick={() => pushToast({ title: "Single payout flow", description: "Use the existing payout API route next; the table screen is wired.", variant: "info" })} variant="primary">New payout</Button>
                    <Button onClick={() => window.open(`${window.location.origin.replace(":5173", ":3000")}/dashboard/v1/payout-batches/template.csv`, "_blank")} variant="secondary">Bulk CSV</Button>
                  </div>
                }
                title=""
              />
              <FilterBar
                filters={[
                  <Select key="status" onValueChange={setStatusFilter} options={[{ label: "All statuses", value: "" }, { label: "Queued", value: "queued" }, { label: "Pending approval", value: "pending_approval" }, { label: "Successful", value: "successful" }, { label: "Failed", value: "failed" }]} value={statusFilter} />
                ]}
                onReset={() => setStatusFilter("")}
              />
              <DataTable
                columns={([
                  { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                  { accessorKey: "reference", header: "Reference", cell: ({ row }) => row.original.reference ?? row.original.id },
                  { accessorKey: "phone", header: "Recipient", cell: ({ row }) => row.original.phone ?? row.original.account_name ?? "-" },
                  { accessorKey: "method", header: "Method", cell: ({ row }) => `${row.original.method}${row.original.network ? ` / ${row.original.network}` : ""}` },
                  { accessorKey: "amount", header: "Amount", cell: ({ row }) => formatMoney(BigInt(row.original.amount), row.original.currency as never, "en-GH") },
                  { accessorKey: "fee_minor", header: "Fee", cell: ({ row }) => formatMoney(BigInt(row.original.fee_minor), row.original.currency as never, "en-GH") },
                  { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.status === "successful" ? "successful" : row.original.status === "failed" ? "failed" : row.original.status === "pending_approval" ? "pending" : row.original.status === "processing" ? "processing" : row.original.status === "reversed" ? "reversed" : "pending") as never} /> }
                ] as ColumnDef<PayoutRow>[]) }
                data={payoutsQuery.data?.data ?? []}
                emptyState={<EmptyState description="Payouts will appear here after the first disbursement." title="No payouts yet" />}
                loading={payoutsQuery.isLoading}
                onRowClick={(row) => setSelectedPayoutId(row.id)}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
              />
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedPayoutId(null);
                  }
                }}
                open={Boolean(selectedPayoutId)}
                title="Payout details"
              >
                {payoutDetailQuery.data ? (
                  <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Recipient</p>
                        <p className="mt-1 font-semibold text-text">
                          {payoutDetailQuery.data.phone ?? payoutDetailQuery.data.account_name ?? "-"}
                        </p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Amount</p>
                        <p className="mt-1 font-semibold text-text">
                          {formatMoney(BigInt(payoutDetailQuery.data.amount), payoutDetailQuery.data.currency as never, "en-GH")}
                        </p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Fee</p>
                        <p className="mt-1 font-semibold text-text">
                          {formatMoney(BigInt(payoutDetailQuery.data.fee_minor), payoutDetailQuery.data.currency as never, "en-GH")}
                        </p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Status</p>
                        <div className="mt-2">
                          <StatusBadge status={(payoutDetailQuery.data.status === "successful" ? "successful" : payoutDetailQuery.data.status === "failed" ? "failed" : payoutDetailQuery.data.status === "processing" ? "processing" : payoutDetailQuery.data.status === "reversed" ? "reversed" : "pending") as never} />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <CopyField label="Payout ID" value={payoutDetailQuery.data.id} />
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Reference</p>
                        <p className="mt-1 text-sm text-text">{payoutDetailQuery.data.reference ?? payoutDetailQuery.data.id}</p>
                      </div>
                      {payoutDetailQuery.data.narration ? (
                        <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                          <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Narration</p>
                          <p className="mt-1 text-sm text-text">{payoutDetailQuery.data.narration}</p>
                        </div>
                      ) : null}
                      {(payoutDetailQuery.data.failure_code || payoutDetailQuery.data.failure_message) ? (
                        <div className="rounded-card border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
                          <p className="font-semibold">Failure details</p>
                          <p className="mt-1">{payoutDetailQuery.data.failure_message ?? payoutDetailQuery.data.failure_code}</p>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {payoutDetailQuery.data.status === "pending_approval" &&
                      (session.role === "owner" || session.role === "finance") ? (
                        <Button onClick={() => void handleApprovePayout()} variant="primary">
                          Approve payout
                        </Button>
                      ) : null}
                      {payoutDetailQuery.data.status === "pending_approval" ? (
                        <Button
                          onClick={() =>
                            pushToast({
                              title: "Reject action pending",
                              description: "The dashboard backend exposes approval today; reject still needs a dedicated endpoint.",
                              variant: "info"
                            })
                          }
                          variant="secondary"
                        >
                          Reject payout
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </Drawer>
            </>
          ) : null}

          {currentPage === "/payment-links" ? (
            <>
              <PageHeader
                action={<Button onClick={() => setPaymentLinkOpen(true)} variant="primary">Create link</Button>}
                subtitle="Reusable payment links for collecting money without writing code."
                title="Payment links"
              />
              <SummaryCardGrid columns={3}>
                <SummaryCard icon={<Link2 className="size-4" />} label="Active links" value={summaryQuery.data?.payment_links.active_links ?? 0} />
                <SummaryCard icon={<CreditCard className="size-4" />} label="Payments via links" value={summaryQuery.data?.payment_links.payments_via_links ?? 0} />
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Amount collected" value={<MoneyText amountMinor={BigInt(summaryQuery.data?.payment_links.amount_collected_minor ?? 0)} currency={currency as never} />} />
              </SummaryCardGrid>
              <DataTable
                columns={([
                  { accessorKey: "title", header: "Title" },
                  { accessorKey: "amount", header: "Amount", cell: ({ row }) => row.original.amount === null ? "Customer enters" : formatMoney(BigInt(row.original.amount), row.original.currency as never, "en-GH") },
                  { accessorKey: "reusable", header: "Uses", cell: ({ row }) => row.original.reusable ? "Reusable" : "One-time" },
                  { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDate(row.original.created_at, timeZone) }
                ] as ColumnDef<PaymentLinkRow>[]) }
                data={paymentLinksQuery.data ?? []}
                emptyState={<EmptyState description="Create your first payment link for quick merchant collections." title="No payment links yet" />}
                loading={paymentLinksQuery.isLoading}
                onRowClick={(row) => setSelectedPaymentLinkId(row.id)}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
              />
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedPaymentLinkId(null);
                  }
                }}
                open={Boolean(selectedPaymentLinkId)}
                title="Payment link details"
              >
                {selectedPaymentLink ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Title</p>
                        <p className="mt-1 font-semibold text-text">{selectedPaymentLink.title}</p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Amount</p>
                        <p className="mt-1 font-semibold text-text">
                          {selectedPaymentLink.amount === null
                            ? "Customer enters amount"
                            : formatMoney(BigInt(selectedPaymentLink.amount), selectedPaymentLink.currency as never, "en-GH")}
                        </p>
                      </div>
                    </div>
                    <CopyField label="Payment link URL" value={selectedPaymentLink.link_url} />
                    <div className="flex flex-wrap gap-3">
                      <Button
                        onClick={async () => {
                          await navigator.clipboard.writeText(selectedPaymentLink.link_url);
                          pushToast({
                            title: "Link copied",
                            description: "The payment link URL is in your clipboard.",
                            variant: "success"
                          });
                        }}
                        variant="secondary"
                      >
                        Copy link
                      </Button>
                      <Button
                        onClick={() => void handleSharePaymentLink(selectedPaymentLink)}
                        variant="primary"
                      >
                        Share link
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Drawer>
              <Modal
                onOpenChange={(open) => {
                  setPaymentLinkOpen(open);
                  if (!open) {
                    setNewLinkResult(null);
                  }
                }}
                open={paymentLinkOpen}
                title={newLinkResult ? "Payment link ready" : "Create payment link"}
              >
                <div className="space-y-4">
                  {newLinkResult ? (
                    <>
                      <CopyField label="Payment link URL" value={newLinkResult.link_url} />
                      <div className="flex flex-wrap gap-3">
                        <Button
                          onClick={async () => {
                            await navigator.clipboard.writeText(newLinkResult.link_url);
                            pushToast({
                              title: "Link copied",
                              description: "The payment link URL is in your clipboard.",
                              variant: "success"
                            });
                          }}
                          variant="secondary"
                        >
                          Copy link
                        </Button>
                        <Button
                          onClick={() => void handleSharePaymentLink(newLinkResult)}
                          variant="primary"
                        >
                          Share link
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Input label="Title" onChange={(event) => setNewLinkTitle(event.target.value)} value={newLinkTitle} />
                      <Input label={`Amount (${currency})`} onChange={(event) => setNewLinkAmount(event.target.value)} value={newLinkAmount} />
                      <div className="flex justify-end gap-3">
                        <Button
                          onClick={async () => {
                            if (!auth.accessToken || !merchantId) {
                              return;
                            }
                            try {
                              const created = await apiRequest<PaymentLinkRow>("/dashboard/v1/payment-links", {
                                accessToken: auth.accessToken,
                                body: JSON.stringify({
                                  active: true,
                                  amount: Number(newLinkAmount),
                                  amount_mode: "fixed",
                                  currency,
                                  reusable: true,
                                  slug: newLinkTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                                  title: newLinkTitle
                                }),
                                merchantId,
                                method: "POST"
                              });

                              setNewLinkResult(created);
                              pushToast({ title: "Payment link created", description: created.link_url, variant: "success" });
                              await Promise.all([
                                queryClient.invalidateQueries({ queryKey: ["dashboard-payment-links"] }),
                                queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
                              ]);
                            } catch (error) {
                              pushToast({ title: "Create link failed", description: error instanceof ApiError ? error.message : "Unable to create payment link.", variant: "danger" });
                            }
                          }}
                          variant="primary"
                        >
                          Create link
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </Modal>
            </>
          ) : null}

          {currentPage === "/messages" ? (
            <>
              <PageHeader
                action={<Button onClick={() => setBroadcastOpen(true)} variant="primary">New broadcast</Button>}
                subtitle="Monitor delivery performance and queue branded broadcasts."
                title="Messages"
              />
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<Send className="size-4" />} label="Sent" value={summaryQuery.data?.messages.sent ?? 0} />
                <SummaryCard icon={<Activity className="size-4" />} label="Delivery rate" value={`${summaryQuery.data?.messages.delivery_rate ?? 0}%`} />
                <SummaryCard icon={<BookText className="size-4" />} label="Failed" value={summaryQuery.data?.messages.failed ?? 0} />
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="SMS spend" value={<MoneyText amountMinor={BigInt(summaryQuery.data?.messages.spend_minor ?? 0)} currency={currency as never} />} />
              </SummaryCardGrid>
              <FilterBar
                filters={[
                  <DateRangePicker key="range" onChange={setDateRange} value={dateRange} />,
                  <Select key="status" onValueChange={setStatusFilter} options={[{ label: "All statuses", value: "" }, { label: "Queued", value: "queued" }, { label: "Delivered", value: "delivered" }, { label: "Failed", value: "failed" }, { label: "Undelivered", value: "undelivered" }]} value={statusFilter} />,
                  <Select key="sender" onValueChange={setComposeSenderId} options={[{ label: "All sender IDs", value: "" }, ...senderIdOptions]} value={composeSenderId} />
                ]}
                onReset={() => {
                  setDateRange(makeDateRangeValue());
                  setStatusFilter("");
                  setComposeSenderId("");
                }}
              />
              <Tabs
                items={[
                  {
                    label: "Messages",
                    value: "messages",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                          { accessorKey: "recipient", header: "Recipient", cell: ({ row }) => row.original.recipient_masked ?? row.original.recipient },
                          { accessorKey: "sender_id", header: "Sender ID" },
                          { accessorKey: "preview", header: "Preview" },
                          { accessorKey: "segments", header: "Segments" },
                          { accessorKey: "cost_minor", header: "Cost", cell: ({ row }) => formatMoney(BigInt(row.original.cost_minor), currency as never, "en-GH") },
                          { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status as never} /> }
                        ] as ColumnDef<MessageRow>[]) }
                        data={messagesQuery.data?.data ?? []}
                        emptyState={<EmptyState description="Messages will appear here once your merchant sends the first SMS." title="No messages yet" />}
                        loading={messagesQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Broadcasts",
                    value: "broadcasts",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                          { accessorKey: "body_preview", header: "Message" },
                          { accessorKey: "sender_id", header: "Sender ID", cell: ({ row }) => row.original.sender_id ?? "-" },
                          { accessorKey: "accepted_count", header: "Delivered/Pending", cell: ({ row }) => `${row.original.delivered_count}/${row.original.pending_count}` },
                          { accessorKey: "failed_count", header: "Failed" },
                          { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.status === "completed" ? "successful" : row.original.status === "partial" ? "processing" : "pending") as never} /> }
                        ] as ColumnDef<BroadcastRow>[]) }
                        data={broadcastsQuery.data?.data ?? []}
                        emptyState={<EmptyState description="Queued broadcasts and delivery counts will appear here." title="No broadcasts yet" />}
                        loading={broadcastsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  }
                ]}
              />
              <Drawer onOpenChange={setBroadcastOpen} open={broadcastOpen} title="New broadcast">
                <div className="space-y-4">
                  <Textarea label="Paste numbers (comma or new line)" onChange={(event) => setComposeRecipients(event.target.value)} value={composeRecipients} />
                  <div className="grid gap-4 md:grid-cols-2">
                    <Select label="Contact group" onValueChange={setComposeGroupId} options={[{ label: "No group", value: "" }, ...groupOptions]} value={composeGroupId} />
                    <Select label="Sender ID" onValueChange={setComposeSenderId} options={senderIdOptions} value={composeSenderId || senderIdOptions[0]?.value} />
                  </div>
                  <div className="rounded-input border border-dashed border-border bg-surface-subtle p-4">
                    <Input
                      label="Upload CSV file"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          return;
                        }
                        setComposeUploadName(file.name);
                        const text = await file.text();
                        setComposeRecipients(text);
                      }}
                      type="file"
                    />
                    <p className="mt-2 text-xs text-text-secondary">CSV import is supported here. Excel uploads still need a parser pass.</p>
                  </div>
                  <Textarea label="Message" onChange={(event) => setComposeMessage(event.target.value)} value={composeMessage} />
                  <div className="grid gap-4 md:grid-cols-3">
                    <Select label="Type" onValueChange={setComposeType} options={[{ label: "Marketing", value: "marketing" }, { label: "Transactional", value: "transactional" }, { label: "OTP", value: "otp" }]} value={composeType} />
                    <Input label="Schedule at" onChange={(event) => setComposeScheduleAt(event.target.value)} type="datetime-local" value={composeScheduleAt} />
                    <div className="rounded-input border border-border bg-surface-subtle px-4 py-3 text-sm">
                      <p className="font-medium text-text">Live counter</p>
                      <p className="mt-2 text-text-secondary">Recipients: {validRecipientRows.length}</p>
                      <p className="text-text-secondary">Invalid: {invalidRecipientRows.length}</p>
                      <p className="text-text-secondary">Segments: {estimatedSegments}</p>
                      <p className="text-text-secondary">Estimated cost: {formatMoney(BigInt(estimatedCost), currency as never, "en-GH")}</p>
                    </div>
                  </div>
                  {invalidRecipientRows.length > 0 ? (
                    <div className="rounded-card border border-warning/40 bg-warning/10 p-4 text-sm text-amber-900">
                      Invalid numbers: {invalidRecipientRows.map((row) => row.original).join(", ")}
                    </div>
                  ) : null}
                  <ConfirmDialog
                    confirmLabel="Queue broadcast"
                    description={`Recipients: ${validRecipientRows.length}. Estimated cost: ${formatMoney(BigInt(estimatedCost), currency as never, "en-GH")}. Balance after send: ${formatMoney(BigInt(Math.max((summaryQuery.data?.balance.available_minor ?? 0) - estimatedCost, 0)), currency as never, "en-GH")}.`}
                    onConfirm={handleBroadcastSend}
                    title="Confirm broadcast"
                    trigger={<Button variant="primary">Review and send</Button>}
                  >
                    <p className="text-sm text-text-secondary">This confirms the recipient count, estimated cost, and post-send balance before the batch is queued.</p>
                  </ConfirmDialog>
                </div>
              </Drawer>
            </>
          ) : null}

          {currentPage === "/airtime" ? (
            <>
              <PageHeader
                action={<Button onClick={() => setAirtimeOpen(true)} variant="primary">Send airtime</Button>}
                subtitle="Top up mobile numbers from your available balance."
                title="Airtime"
              />
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<Smartphone className="size-4" />} label="Airtime sent" value={airtimeSummaryQuery.data?.sent ?? 0} />
                <SummaryCard icon={<Send className="size-4" />} label="Successful" value={airtimeSummaryQuery.data?.successful ?? 0} />
                <SummaryCard icon={<Activity className="size-4" />} label="Failed" value={airtimeSummaryQuery.data?.failed ?? 0} />
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Spend" value={<MoneyText amountMinor={BigInt(airtimeSummaryQuery.data?.spend_minor ?? 0)} currency={currency as never} />} />
              </SummaryCardGrid>
              <FilterBar
                filters={[
                  <DateRangePicker key="range" onChange={setDateRange} value={dateRange} />,
                  <Select key="status" onValueChange={setStatusFilter} options={[{ label: "All statuses", value: "" }, { label: "Pending", value: "pending" }, { label: "Processing", value: "processing" }, { label: "Successful", value: "successful" }, { label: "Failed", value: "failed" }]} value={statusFilter} />,
                  <Select
                    key="network"
                    onValueChange={setAirtimeNetworkFilter}
                    options={[
                      { label: "All networks", value: "" },
                      ...Array.from(new Set((airtimeNetworksQuery.data ?? []).map((network) => network.network))).map((network) => ({
                        label: network,
                        value: network
                      }))
                    ]}
                    value={airtimeNetworkFilter}
                  />
                ]}
                onReset={() => {
                  setDateRange(makeDateRangeValue());
                  setStatusFilter("");
                  setAirtimeNetworkFilter("");
                  setSearch("");
                }}
                onSearchChange={setSearch}
                placeholder="Search phone"
                searchValue={search}
              />
              <div className="flex justify-end">
                <Button
                  onClick={() =>
                    exportCsv(
                      "airtime-orders.csv",
                      ["Date", "Recipient", "Network", "Amount", "Cost", "Status", "Reference"],
                      (airtimeOrdersQuery.data ?? []).map((row) => [
                        row.created_at,
                        row.phone_masked ?? maskRecipient(row.phone),
                        row.network,
                        formatMoney(BigInt(row.amount), row.currency as never, "en-GH"),
                        formatMoney(BigInt(row.charge_amount), row.charge_currency as never, "en-GH"),
                        row.status,
                        row.reference
                      ])
                    )
                  }
                  variant="ghost"
                >
                  <Download className="size-4" />
                  Export CSV
                </Button>
              </div>
              <Tabs
                items={[
                  {
                    label: "Orders",
                    value: "orders",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                          { accessorKey: "phone", header: "Recipient", cell: ({ row }) => row.original.phone_masked ?? maskRecipient(row.original.phone) },
                          { accessorKey: "network", header: "Network" },
                          { accessorKey: "amount", header: "Amount", cell: ({ row }) => formatMoney(BigInt(row.original.amount), row.original.currency as never, "en-GH") },
                          { accessorKey: "charge_amount", header: "Cost", cell: ({ row }) => formatMoney(BigInt(row.original.charge_amount), row.original.charge_currency as never, "en-GH") },
                          { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status as never} /> },
                          { accessorKey: "reference", header: "Reference", cell: ({ row }) => row.original.reference ?? "-" }
                        ] as ColumnDef<AirtimeOrderRow>[]) }
                        data={airtimeOrdersQuery.data ?? []}
                        emptyState={<EmptyState action={<Button onClick={() => setAirtimeOpen(true)} variant="primary">Send airtime</Button>} description="Send a single top-up or paste a list of numbers to get started." title="No airtime orders yet" />}
                        loading={airtimeOrdersQuery.isLoading}
                        onRowClick={(row) => setSelectedAirtimeId(row.id)}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Batches",
                    value: "batches",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                          { accessorKey: "reference", header: "Reference", cell: ({ row }) => row.original.reference ?? row.original.id },
                          { accessorKey: "accepted", header: "Accepted" },
                          { accessorKey: "successful", header: "Successful" },
                          { accessorKey: "failed", header: "Failed" },
                          {
                            accessorKey: "status",
                            header: "Progress",
                            cell: ({ row }) => {
                              const pending = Math.max(
                                row.original.accepted - row.original.successful - row.original.failed,
                                0
                              );
                              const percent = row.original.accepted === 0
                                ? 0
                                : Math.round(((row.original.successful + row.original.failed) / row.original.accepted) * 100);
                              return (
                                <div className="space-y-1">
                                  <StatusBadge status={(row.original.status === "completed" ? "successful" : "processing") as never} />
                                  <p className="text-xs text-text-secondary">
                                    {row.original.successful} ok · {row.original.failed} failed · {pending} pending
                                  </p>
                                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-subtle">
                                    <div className="h-full bg-brand" style={{ width: `${percent}%` }} />
                                  </div>
                                </div>
                              );
                            }
                          }
                        ] as ColumnDef<AirtimeBatchRow>[]) }
                        data={airtimeBatchesQuery.data ?? []}
                        emptyState={<EmptyState description="Bulk sends will appear here with accepted, successful, failed and pending counts." title="No airtime batches yet" />}
                        loading={airtimeBatchesQuery.isLoading}
                        onRowClick={(row) => setSelectedAirtimeBatchId(row.id)}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  }
                ]}
              />
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedAirtimeId(null);
                  }
                }}
                open={Boolean(selectedAirtimeId)}
                title="Airtime order"
              >
                {airtimeDetailQuery.data ? (
                  <div className="space-y-5">
                    <CopyField label="Order ID" value={airtimeDetailQuery.data.id} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Recipient</p>
                        <p className="mt-1 font-semibold text-text">{airtimeDetailQuery.data.phone_masked}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Network</p>
                        <p className="mt-1 font-semibold text-text">{airtimeDetailQuery.data.network} ({airtimeDetailQuery.data.country_code})</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Face value</p>
                        <p className="mt-1 font-semibold text-text">{formatMoney(BigInt(airtimeDetailQuery.data.amount), airtimeDetailQuery.data.currency as never, "en-GH")}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Discount</p>
                        <p className="mt-1 font-semibold text-text">{formatMoney(BigInt(airtimeDetailQuery.data.discount_minor), airtimeDetailQuery.data.currency as never, "en-GH")}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Charge</p>
                        <p className="mt-1 font-semibold text-text">{formatMoney(BigInt(airtimeDetailQuery.data.charge_amount), airtimeDetailQuery.data.charge_currency as never, "en-GH")}</p>
                      </div>
                      {airtimeDetailQuery.data.fx_rate ? (
                        <div>
                          <p className="text-xs uppercase tracking-[0.16em] text-text-muted">FX rate</p>
                          <p className="mt-1 font-semibold text-text">{airtimeDetailQuery.data.fx_rate}</p>
                        </div>
                      ) : null}
                    </div>
                    {airtimeDetailQuery.data.batch_id ? (
                      <Button
                        onClick={() => {
                          setSelectedAirtimeId(null);
                          setSelectedAirtimeBatchId(airtimeDetailQuery.data?.batch_id ?? null);
                        }}
                        variant="secondary"
                      >
                        Open batch {airtimeDetailQuery.data.batch_id}
                      </Button>
                    ) : null}
                    <div className="space-y-3">
                      <h4 className="font-semibold text-text">Status timeline</h4>
                      {airtimeDetailQuery.data.event_timeline.length === 0 ? (
                        <p className="text-sm text-text-secondary">No status events yet.</p>
                      ) : (
                        airtimeDetailQuery.data.event_timeline.map((event, index) => (
                          <div className="rounded-input border border-border bg-surface-subtle px-4 py-3" key={`${event.created_at}-${index}`}>
                            <p className="font-medium text-text">{event.from_status ?? "start"} to {event.to_status}</p>
                            <p className="text-sm text-text-secondary">{formatDateTime(event.created_at, timeZone)}</p>
                            {event.reason ? <p className="mt-1 text-sm text-text-secondary">{event.reason}</p> : null}
                          </div>
                        ))
                      )}
                    </div>
                    <StatusBadge status={airtimeDetailQuery.data.status as never} />
                  </div>
                ) : (
                  <p className="text-sm text-text-secondary">Loading order details.</p>
                )}
              </Drawer>
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedAirtimeBatchId(null);
                  }
                }}
                open={Boolean(selectedAirtimeBatchId)}
                title="Airtime batch"
              >
                {(() => {
                  const batch = (airtimeBatchesQuery.data ?? []).find((row) => row.id === selectedAirtimeBatchId);
                  if (!batch) {
                    return <p className="text-sm text-text-secondary">This batch is no longer on the current page.</p>;
                  }

                  const pending = Math.max(batch.accepted - batch.successful - batch.failed, 0);
                  const percent = batch.accepted === 0
                    ? 0
                    : Math.round(((batch.successful + batch.failed) / batch.accepted) * 100);

                  return (
                    <div className="space-y-4">
                      <CopyField label="Batch ID" value={batch.id} />
                      <p className="text-sm text-text-secondary">
                        {batch.accepted} accepted · {batch.successful} successful · {batch.failed} failed · {pending} pending
                      </p>
                      <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
                        <div className="h-full bg-brand" style={{ width: `${percent}%` }} />
                      </div>
                      <p className="text-sm text-text">
                        Total cost {formatMoney(BigInt(batch.total_charge), batch.charge_currency as never, "en-GH")}
                      </p>
                    </div>
                  );
                })()}
              </Drawer>
              <Drawer onOpenChange={setAirtimeOpen} open={airtimeOpen} title="Send airtime">
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Button onClick={() => setAirtimeMode("single")} variant={airtimeMode === "single" ? "primary" : "secondary"}>Single</Button>
                    <Button onClick={() => setAirtimeMode("bulk")} variant={airtimeMode === "bulk" ? "primary" : "secondary"}>Bulk</Button>
                  </div>
                  {airtimeMode === "single" ? (
                    <div className="space-y-4">
                      <Input label="Phone number" onChange={(event) => setAirtimePhone(event.target.value)} placeholder="+260970000001" value={airtimePhone} />
                      {airtimeQuoteNetwork ? (
                        <p className="text-sm text-text-secondary">Network: {airtimeQuoteNetwork.network} · {airtimeQuoteNetwork.country_code}</p>
                      ) : null}
                      {airtimeFixedDenoms.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {airtimeFixedDenoms.map((amount) => (
                            <Button
                              key={amount}
                              onClick={() => setAirtimeAmount(fromMinor(BigInt(amount), (airtimeQuoteNetwork?.currency ?? currency) as CurrencyCode))}
                              variant={airtimeAmountMinor === amount ? "primary" : "secondary"}
                            >
                              {formatMoney(BigInt(amount), (airtimeQuoteNetwork?.currency ?? currency) as never, "en-GH")}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <Input label="Amount" onChange={(event) => setAirtimeAmount(event.target.value)} placeholder="10.00" value={airtimeAmount} />
                      )}
                      {airtimeQuoteNetwork && airtimeQuoteNetwork.amount > 0 ? (
                        <div className="rounded-card border border-border bg-surface-subtle px-4 py-3 text-sm text-text">
                          Recipient gets {formatMoney(BigInt(airtimeQuoteNetwork.amount), airtimeQuoteNetwork.currency as never, "en-GH")}, you pay {formatMoney(BigInt(airtimeQuoteNetwork.charge_amount), airtimeQuoteNetwork.charge_currency as never, "en-GH")}
                        </div>
                      ) : airtimeQuoteQuery.isError ? (
                        <p className="text-sm text-danger">{airtimeQuoteQuery.error instanceof ApiError ? airtimeQuoteQuery.error.message : "Unable to quote this number."}</p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <Textarea
                        label="Paste numbers"
                        onChange={(event) => {
                          setAirtimePhonesText(event.target.value);
                          setAirtimeCsv("");
                        }}
                        placeholder="+260970000001, +260960000001"
                        value={airtimePhonesText}
                      />
                      <Input label="Amount for pasted numbers" onChange={(event) => setAirtimeAmount(event.target.value)} placeholder="10.00" value={airtimeAmount} />
                      <Select
                        label="Contact group"
                        onValueChange={setAirtimeGroupId}
                        options={[
                          { label: "No group", value: "" },
                          ...(airtimeGroupsQuery.data ?? []).map((group) => ({
                            label: `${group.name} (${group.contact_count})`,
                            value: group.id
                          }))
                        ]}
                        value={airtimeGroupId}
                      />
                      <div className="rounded-input border border-dashed border-border bg-surface-subtle p-4">
                        <Input
                          label="Upload CSV"
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            if (!file) {
                              return;
                            }
                            setAirtimeCsv(await file.text());
                            setAirtimePhonesText("");
                          }}
                          type="file"
                        />
                        <Button
                          className="mt-3"
                          onClick={() =>
                            exportCsv("airtime-recipients.csv", ["phone", "amount"], [["+260970000001", 1000]])
                          }
                          variant="ghost"
                        >
                          Download CSV template
                        </Button>
                      </div>
                      <DataTable
                        columns={([
                          { accessorKey: "phone", header: "Recipient" },
                          { accessorKey: "amount", header: "Amount", cell: ({ row }) => Number.isSafeInteger(row.original.amount) ? formatMoney(BigInt(row.original.amount), (airtimeQuoteNetwork?.currency ?? currency) as never, "en-GH") : "-" },
                          { accessorKey: "error", header: "Error", cell: ({ row }) => row.original.error ?? "" }
                        ] as ColumnDef<(typeof airtimePreviewRows)[number]>[]) }
                        data={airtimePreviewRows}
                        emptyState={<EmptyState description="Paste numbers, upload a CSV, or pick a contact group to preview recipients." title="No recipients yet" />}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    </div>
                  )}
                  <Input label="Reference (optional)" onChange={(event) => setAirtimeReference(event.target.value)} value={airtimeReference} />
                  {airtimeBalanceTooLow ? (
                    <div className="space-y-3 rounded-card border border-danger/30 bg-danger/10 p-4">
                      <p className="text-sm text-danger">
                        Available balance {formatMoney(BigInt(airtimeBalance), currency as never, "en-GH")} is too low for this send of {formatMoney(BigInt(airtimeCostTotal), (airtimeQuoteNetwork?.charge_currency ?? currency) as never, "en-GH")}.
                      </p>
                      <Button
                        onClick={() => {
                          setAirtimeOpen(false);
                          setTopupOpen(true);
                        }}
                        variant="primary"
                      >
                        Top up
                      </Button>
                    </div>
                  ) : (
                    <ConfirmDialog
                      confirmLabel="Send airtime"
                      description={`Recipients: ${airtimeMode === "single" ? 1 : validAirtimeRows.length}. Total airtime: ${formatMoney(BigInt(Math.max(airtimeFaceTotal, 0)), (airtimeQuoteNetwork?.currency ?? currency) as never, "en-GH")}. Total cost: ${formatMoney(BigInt(Math.max(airtimeCostTotal, 0)), (airtimeQuoteNetwork?.charge_currency ?? currency) as never, "en-GH")}. Balance after: ${formatMoney(BigInt(Math.max(airtimeBalanceAfter, 0)), currency as never, "en-GH")}.`}
                      onConfirm={handleAirtimeSend}
                      onOpenChange={setAirtimeConfirmOpen}
                      open={airtimeConfirmOpen}
                      title="Confirm airtime"
                      trigger={<Button variant="primary">Review and send</Button>}
                    >
                      <p className="text-sm text-text-secondary">Check the recipient count, face value, cost, and remaining balance before the top-up is queued.</p>
                    </ConfirmDialog>
                  )}
                </div>
              </Drawer>
            </>
          ) : null}

          {currentPage === "/contacts" ? (
            <>
              <PageHeader
                action={<Button onClick={() => setContactImportOpen(true)} variant="primary">Import contacts</Button>}
                subtitle="Manage contact groups and reusable broadcast lists."
                title="Contacts"
              />
              <SummaryCardGrid columns={3}>
                <SummaryCard icon={<Users className="size-4" />} label="Contacts" value={contactsQuery.data?.contacts.length ?? 0} />
                <SummaryCard icon={<BriefcaseBusiness className="size-4" />} label="Groups" value={contactsQuery.data?.groups.length ?? 0} />
                <SummaryCard icon={<ShieldCheck className="size-4" />} label="Opt-outs" value={contactsQuery.data?.opt_out_count ?? 0} />
              </SummaryCardGrid>
              <Tabs
                items={[
                  {
                    label: "Groups",
                    value: "groups",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "name", header: "Group" },
                          { accessorKey: "contact_count", header: "Contacts" },
                          { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDate(row.original.created_at, timeZone) }
                        ] as ColumnDef<ContactGroupRow>[]) }
                        data={contactsQuery.data?.groups ?? []}
                        emptyState={<EmptyState description="Create or import a group to start reusing recipient lists." title="No groups yet" />}
                        loading={contactsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Contacts",
                    value: "contacts",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "name", header: "Name", cell: ({ row }) => row.original.name ?? "-" },
                          { accessorKey: "phone", header: "Phone", cell: ({ row }) => row.original.phone_masked ?? row.original.phone },
                          { accessorKey: "group_count", header: "Groups" },
                          { accessorKey: "tags", header: "Tags", cell: ({ row }) => row.original.tags.join(", ") || "-" },
                          { accessorKey: "opted_out", header: "Opt-out", cell: ({ row }) => row.original.opted_out ? "Yes" : "No" }
                        ] as ColumnDef<ContactRow>[]) }
                        data={contactsQuery.data?.contacts ?? []}
                        emptyState={<EmptyState description="Contacts imported from CSV will appear here." title="No contacts yet" />}
                        loading={contactsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  }
                ]}
              />
              <Modal onOpenChange={setContactImportOpen} open={contactImportOpen} title="Import contacts">
                <div className="space-y-4">
                  <Input label="Group name" onChange={(event) => setContactGroupName(event.target.value)} value={contactGroupName} />
                  <Textarea
                    label="CSV rows"
                    onChange={(event) => setContactCsv(event.target.value)}
                    placeholder={"name,phone,tags\nJane,+233241230001,VIP|Reminder"}
                    value={contactCsv}
                  />
                  <div className="flex justify-end gap-3">
                    <Button
                      onClick={async () => {
                        if (!auth.accessToken || !merchantId) {
                          return;
                        }
                        const rows = contactCsv
                          .split(/\r?\n/)
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .slice(1)
                          .map((line) => {
                            const [name, phone, tags] = line.split(",");
                            return {
                              name: name?.trim(),
                              phone: phone?.trim() ?? "",
                              tags: tags ? tags.split("|").map((tag) => tag.trim()).filter(Boolean) : []
                            };
                          });

                        try {
                          await apiRequest("/dashboard/v1/contacts/import", {
                            accessToken: auth.accessToken,
                            body: JSON.stringify({
                              contacts: rows,
                              group_name: contactGroupName || undefined
                            }),
                            merchantId,
                            method: "POST"
                          });
                          setContactImportOpen(false);
                          setContactCsv("");
                          setContactGroupName("");
                          pushToast({ title: "Contacts imported", description: `${rows.length} contact rows were processed.`, variant: "success" });
                          await queryClient.invalidateQueries({ queryKey: ["dashboard-contacts"] });
                        } catch (error) {
                          pushToast({ title: "Import failed", description: error instanceof ApiError ? error.message : "Unable to import contacts.", variant: "danger" });
                        }
                      }}
                      variant="primary"
                    >
                      Import
                    </Button>
                  </div>
                </div>
              </Modal>
            </>
          ) : null}

          {currentPage === "/balance" ? (
            <>
              <PageHeader
                action={
                  <div className="flex gap-3">
                    <Button onClick={() => setTopupOpen(true)} variant="primary">Top up</Button>
                    {session.active_products.collections ? (
                      <Button onClick={() => setWithdrawOpen(true)} variant="secondary">Withdraw</Button>
                    ) : null}
                  </div>
                }
                subtitle="Current balances and the ledger movement statement for this merchant."
                title="Balance"
              />
              <SummaryCardGrid columns={4}>
                {(balanceQuery.data ?? []).map((row) => (
                  <SummaryCard
                    icon={<CircleDollarSign className="size-4" />}
                    key={row.type}
                    label={row.type.replace("merchant_", "").replaceAll("_", " ")}
                    value={<MoneyText amountMinor={BigInt(row.amount_minor)} currency={row.currency as never} />}
                  />
                ))}
              </SummaryCardGrid>
              <FilterBar
                filters={[
                  <Select key="entry" onValueChange={setMethodFilter} options={[{ label: "All entries", value: "" }, { label: "Collection", value: "collection" }, { label: "Payout", value: "payout" }, { label: "SMS", value: "sms" }, { label: "Top-up", value: "topup" }]} value={methodFilter} />
                ]}
                onReset={() => setMethodFilter("")}
              />
              <DataTable
                columns={([
                  { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                  { accessorKey: "reference_type", header: "Entry type" },
                  { accessorKey: "description", header: "Description" },
                  { accessorKey: "account_type", header: "Account" },
                  { accessorKey: "direction", header: "Direction" },
                  { accessorKey: "amount_minor", header: "Amount", cell: ({ row }) => formatMoney(BigInt(row.original.amount_minor), row.original.currency as never, "en-GH") }
                ] as ColumnDef<StatementRow>[]) }
                data={statementQuery.data ?? []}
                emptyState={<EmptyState description="Ledger movements will appear here as money moves through the platform." title="No ledger entries yet" />}
                loading={statementQuery.isLoading}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
              />
              <Modal onOpenChange={setTopupOpen} open={topupOpen} title="Top up balance">
                <div className="space-y-4">
                  <Input label={`Amount (${currency})`} onChange={(event) => setTopupAmount(event.target.value)} value={topupAmount} />
                  <Select label="Method" onValueChange={setTopupMethod} options={[{ label: "Bank transfer", value: "bank_transfer" }, { label: "Mobile money", value: "mobile_money" }, { label: "Card", value: "card" }]} value={topupMethod} />
                  <div className="flex justify-end gap-3">
                    <Button
                      onClick={async () => {
                        if (!auth.accessToken || !merchantId) {
                          return;
                        }
                        try {
                          await apiRequest("/dashboard/v1/topups", {
                            accessToken: auth.accessToken,
                            body: JSON.stringify({
                              amount: Number(topupAmount),
                              currency,
                              method: topupMethod
                            }),
                            merchantId,
                            method: "POST"
                          });
                          setTopupOpen(false);
                          pushToast({ title: "Top-up started", description: "Your top-up request has been created.", variant: "success" });
                          await queryClient.invalidateQueries({ queryKey: ["dashboard-balance"] });
                        } catch (error) {
                          pushToast({ title: "Top-up failed", description: error instanceof ApiError ? error.message : "Unable to start the top-up.", variant: "danger" });
                        }
                      }}
                      variant="primary"
                    >
                      Start top-up
                    </Button>
                  </div>
                </div>
              </Modal>
              <Modal onOpenChange={setWithdrawOpen} open={withdrawOpen} title="Withdraw funds">
                <div className="space-y-4">
                  <Input label={`Amount (${currency})`} onChange={(event) => setWithdrawAmount(event.target.value)} value={withdrawAmount} />
                  <Select label="Settlement account" onValueChange={setWithdrawAccountId} options={settlementAccountOptions} value={withdrawAccountId} />
                  <div className="flex justify-end gap-3">
                    <Button
                      onClick={async () => {
                        if (!auth.accessToken || !merchantId) {
                          return;
                        }
                        try {
                          await apiRequest("/dashboard/v1/withdrawals", {
                            accessToken: auth.accessToken,
                            body: JSON.stringify({
                              amount: Number(withdrawAmount),
                              currency,
                              settlement_account_id: withdrawAccountId
                            }),
                            merchantId,
                            method: "POST"
                          });
                          setWithdrawOpen(false);
                          pushToast({ title: "Withdrawal queued", description: "The withdrawal has been submitted to the payout engine.", variant: "success" });
                        } catch (error) {
                          pushToast({ title: "Withdrawal failed", description: error instanceof ApiError ? error.message : "Unable to create the withdrawal.", variant: "danger" });
                        }
                      }}
                      variant="primary"
                    >
                      Create withdrawal
                    </Button>
                  </div>
                </div>
              </Modal>
            </>
          ) : null}

          {currentPage === "/developers" ? (
            <>
              <PageHeader
                subtitle="Manage API keys, webhook endpoints, request logs, and merchant event deliveries from one place."
                title="Developers"
              />
              <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold text-text">Quick start</h3>
                    <p className="max-w-2xl text-sm text-text-secondary">
                      Start with a test key and simulator numbers before you move to live traffic.
                      The example below is pre-filled with your test key prefix and points to the public API docs.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={async () => {
                        await navigator.clipboard.writeText(quickStartCurl);
                        pushToast({
                          title: "cURL copied",
                          description: "The quick start request is ready to paste into your terminal.",
                          variant: "success"
                        });
                      }}
                      variant="secondary"
                    >
                      Copy cURL
                    </Button>
                    <a href={publicDocsUrl} rel="noreferrer" target="_blank">
                      <Button variant="primary">Open API docs (PDF)</Button>
                    </a>
                  </div>
                </div>
                <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
                  <Textarea
                    className="min-h-64 font-mono text-xs"
                    label="Example request"
                    readOnly
                    value={quickStartCurl}
                  />
                  <div className="space-y-4">
                    <CopyField label="Suggested test key prefix" value={testSecretKeyPrefix} />
                    <div className="rounded-card border border-warning/30 bg-warning/10 p-4 text-sm text-amber-900">
                      <p className="font-semibold">Use test mode first</p>
                      <p className="mt-1">
                        Simulator numbers ending in <code>0001</code> succeed, <code>0002</code> fail,
                        and <code>0003</code> stay pending until a later status check. Airtime uses the
                        same last-four shortcuts on the recipient number.
                      </p>
                    </div>
                  </div>
                </div>
              </section>
              <Tabs
                items={[
                  {
                    label: "API keys",
                    value: "api-keys",
                    content: (
                      <div className="space-y-4">
                        <FilterBar
                          filters={[
                            <Select
                              key="api-key-mode"
                              label="Mode"
                              onValueChange={(value) => {
                                setDeveloperSearch("");
                                setSelectedApiKeyId(null);
                                setApiKeyModeFilter(value);
                              }}
                              options={[
                                { label: "All keys", value: "" },
                                { label: "Test", value: "test" },
                                { label: "Live", value: "live" }
                              ]}
                              value={apiKeyModeFilter}
                            />
                          ]}
                          onReset={() => {
                            setApiKeyModeFilter("");
                            setDeveloperSearch("");
                            setSelectedApiKeyId(null);
                          }}
                          onSearchChange={setDeveloperSearch}
                          placeholder="Search name, prefix, or scope"
                          searchValue={developerSearch}
                        />
                        <div className="flex flex-wrap justify-end gap-3">
                          <a href={`${env.apiBaseUrl}/v1/openapi.pdf`} rel="noreferrer" target="_blank">
                            <Button leadingIcon={<BookText className="size-4" />} variant="secondary">
                              API PDF
                            </Button>
                          </a>
                          <Button
                            leadingIcon={<Download className="size-4" />}
                            onClick={() =>
                              exportCsv(
                                "api-keys.csv",
                                ["mode", "name", "prefix", "scopes", "last_used_at", "created_at"],
                                filteredApiKeys.map((row) => [
                                  row.mode,
                                  row.name,
                                  row.prefix,
                                  row.scopes.join(" "),
                                  row.last_used_at,
                                  row.created_at
                                ])
                              )
                            }
                            variant="secondary"
                          >
                            Export CSV
                          </Button>
                          <Button onClick={() => setApiKeyOpen(true)} variant="primary">
                            Create API key
                          </Button>
                        </div>
                        <DataTable
                          columns={([
                            { accessorKey: "mode", header: "Mode", cell: ({ row }) => row.original.mode === "test" ? "Test" : "Live" },
                            { accessorKey: "name", header: "Name" },
                            { accessorKey: "prefix", header: "Prefix" },
                            { accessorKey: "scopes", header: "Scopes", cell: ({ row }) => row.original.scopes.join(", ") },
                            { accessorKey: "last_used_at", header: "Last used", cell: ({ row }) => row.original.last_used_at ? formatDateTime(row.original.last_used_at, timeZone) : "Never" },
                            { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) }
                          ] as ColumnDef<ApiKeyRow>[]) }
                          data={filteredApiKeys}
                          emptyState={<EmptyState description="Create the first API key to start calling the public API." title="No API keys yet" />}
                          loading={apiKeysQuery.isLoading}
                          onRowClick={(row) => setSelectedApiKeyId(row.id)}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                        />
                      </div>
                    )
                  },
                  {
                    label: "Webhooks",
                    value: "webhooks",
                    content: (
                      <div className="space-y-4">
                        <FilterBar
                          onReset={() => {
                            setDeveloperSearch("");
                            setSelectedWebhookId(null);
                          }}
                          onSearchChange={setDeveloperSearch}
                          placeholder="Search URL, description, or event"
                          searchValue={developerSearch}
                        />
                        <div className="flex flex-wrap justify-end gap-3">
                          <Button
                            leadingIcon={<Download className="size-4" />}
                            onClick={() =>
                              exportCsv(
                                "webhooks.csv",
                                ["url", "events", "failures", "updated_at", "enabled"],
                                filteredWebhooks.map((row) => [
                                  row.url,
                                  row.events.join(" "),
                                  row.consecutive_failures,
                                  row.updated_at,
                                  row.enabled
                                ])
                              )
                            }
                            variant="secondary"
                          >
                            Export CSV
                          </Button>
                          <Button onClick={() => setWebhookOpen(true)} variant="primary">
                            Add endpoint
                          </Button>
                        </div>
                        <DataTable
                          columns={([
                            { accessorKey: "url", header: "Endpoint URL" },
                            { accessorKey: "events", header: "Events", cell: ({ row }) => row.original.events.join(", ") },
                            { accessorKey: "consecutive_failures", header: "Failures" },
                            { accessorKey: "updated_at", header: "Updated", cell: ({ row }) => formatDateTime(row.original.updated_at, timeZone) },
                            { accessorKey: "enabled", header: "Status", cell: ({ row }) => row.original.enabled ? "Enabled" : "Disabled" }
                          ] as ColumnDef<WebhookEndpointRow>[]) }
                          data={filteredWebhooks}
                          emptyState={<EmptyState description="Add an endpoint to start receiving RichesPay events." title="No webhook endpoints yet" />}
                          loading={webhooksQuery.isLoading}
                          onRowClick={(row) => setSelectedWebhookId(row.id)}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                        />
                      </div>
                    )
                  },
                  {
                    label: "Logs",
                    value: "logs",
                    content: (
                      <div className="space-y-4">
                        <FilterBar
                          filters={[
                            <Select
                              key="logs-status"
                              label="Status class"
                              onValueChange={setLogStatusClass}
                              options={statusClassOptions}
                              value={logStatusClass}
                            />,
                            <Select
                              key="logs-method"
                              label="Method"
                              onValueChange={setLogMethodFilter}
                              options={httpMethodOptions}
                              value={logMethodFilter}
                            />,
                            <DateRangePicker key="logs-date-range" onChange={setDeveloperDateRange} value={developerDateRange} />
                          ]}
                          onReset={() => {
                            setDeveloperSearch("");
                            setLogMethodFilter("");
                            setLogStatusClass("");
                            setDeveloperDateRange(makeDateRangeValue());
                          }}
                          onSearchChange={setDeveloperSearch}
                          placeholder="Search request ID or path"
                          searchValue={developerSearch}
                        />
                        <div className="flex justify-end">
                          <Button
                            leadingIcon={<Download className="size-4" />}
                            onClick={() =>
                              exportCsv(
                                "api-request-logs.csv",
                                ["created_at", "method", "path", "status_code", "duration_ms", "request_id"],
                                filteredRequestLogs.map((row) => [
                                  row.created_at,
                                  row.method,
                                  row.path,
                                  row.status_code,
                                  row.duration_ms,
                                  row.request_id
                                ])
                              )
                            }
                            variant="secondary"
                          >
                            Export CSV
                          </Button>
                        </div>
                        <DataTable
                          columns={([
                            { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                            { accessorKey: "method", header: "Method" },
                            { accessorKey: "path", header: "Path" },
                            { accessorKey: "status_code", header: "Status", cell: ({ row }) => `${getStatusClass(row.original.status_code)} • ${row.original.status_code}` },
                            { accessorKey: "duration_ms", header: "Duration", cell: ({ row }) => `${row.original.duration_ms} ms` },
                            { accessorKey: "request_id", header: "Request ID" }
                          ] as ColumnDef<ApiRequestLogRow>[]) }
                          data={filteredRequestLogs}
                          emptyState={<EmptyState description="Request logs will appear after API traffic reaches this merchant." title="No request logs yet" />}
                          loading={apiRequestLogsQuery.isLoading}
                          onRowClick={(row) => setSelectedLogRequestId(row.request_id)}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                        />
                      </div>
                    )
                  },
                  {
                    label: "Events",
                    value: "events",
                    content: (
                      <div className="space-y-4">
                        <FilterBar
                          filters={[
                            <Select
                              key="events-type"
                              label="Event type"
                              onValueChange={setEventTypeFilter}
                              options={eventTypeOptions}
                              value={eventTypeFilter}
                            />,
                            <DateRangePicker key="events-date-range" onChange={setDeveloperDateRange} value={developerDateRange} />
                          ]}
                          onReset={() => {
                            setDeveloperSearch("");
                            setEventTypeFilter("");
                            setDeveloperDateRange(makeDateRangeValue());
                          }}
                          onSearchChange={setDeveloperSearch}
                          placeholder="Search event ID or type"
                          searchValue={developerSearch}
                        />
                        <div className="flex justify-end">
                          <Button
                            leadingIcon={<Download className="size-4" />}
                            onClick={() =>
                              exportCsv(
                                "events-outbox.csv",
                                ["created_at", "type", "id"],
                                filteredOutboxEvents.map((row) => [row.created_at, row.type, row.id])
                              )
                            }
                            variant="secondary"
                          >
                            Export CSV
                          </Button>
                        </div>
                        <DataTable
                          columns={([
                            { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                            { accessorKey: "type", header: "Type" },
                            { accessorKey: "id", header: "Event ID" },
                            { accessorKey: "mode", header: "Mode", cell: ({ row }) => row.original.mode === "test" ? "Test" : "Live" }
                          ] as ColumnDef<EventOutboxRow>[]) }
                          data={filteredOutboxEvents}
                          emptyState={<EmptyState description="Merchant events will appear here when RichesPay emits webhookable activity." title="No events yet" />}
                          loading={eventsOutboxQuery.isLoading}
                          onRowClick={(row) => setSelectedEventId(row.id)}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                        />
                      </div>
                    )
                  }
                ]}
              />
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedApiKeyId(null);
                  }
                }}
                open={Boolean(selectedApiKey)}
                title="API key details"
              >
                {selectedApiKey ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Mode</p>
                        <p className="mt-1 font-semibold text-text">{selectedApiKey.mode === "test" ? "Test" : "Live"}</p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Status</p>
                        <p className="mt-1 font-semibold text-text">{selectedApiKey.revoked_at ? "Revoked" : "Active"}</p>
                      </div>
                    </div>
                    <CopyField label="Prefix" value={selectedApiKey.prefix} />
                    <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Scopes</p>
                      <p className="mt-1 text-sm text-text">{selectedApiKey.scopes.join(", ")}</p>
                    </div>
                    <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.16em] text-text-muted">IP allowlist</p>
                      <p className="mt-1 text-sm text-text">{selectedApiKey.ip_allowlist?.join(", ") ?? "No IP restriction"}</p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Last used</p>
                        <p className="mt-1 text-sm text-text">{selectedApiKey.last_used_at ? formatDateTime(selectedApiKey.last_used_at, timeZone) : "Never"}</p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Created</p>
                        <p className="mt-1 text-sm text-text">{formatDateTime(selectedApiKey.created_at, timeZone)}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {selectedApiKey.kind === "secret" && !selectedApiKey.revoked_at ? (
                        <ConfirmDialog
                          confirmLabel="Roll key"
                          description="A new secret will be created and the current key will keep working during the grace period."
                          onConfirm={handleRollApiKey}
                          title="Roll API key"
                          trigger={<Button variant="secondary">Roll key</Button>}
                        >
                          <p className="text-sm text-text-secondary">
                            Copy the replacement secret immediately after rolling. RichesPay shows it only once.
                          </p>
                        </ConfirmDialog>
                      ) : null}
                      {!selectedApiKey.revoked_at ? (
                        <ConfirmDialog
                          confirmLabel="Revoke key"
                          description="Revoked keys stop working immediately."
                          onConfirm={handleRevokeApiKey}
                          title="Revoke API key"
                          trigger={<Button variant="danger">Revoke key</Button>}
                        >
                          <p className="text-sm text-text-secondary">
                            This action cannot be undone. Existing integrations using this key will fail after revocation.
                          </p>
                        </ConfirmDialog>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </Drawer>
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedWebhookId(null);
                  }
                }}
                open={Boolean(selectedWebhook)}
                title="Webhook endpoint"
              >
                {selectedWebhook ? (
                  <div className="space-y-5">
                    <CopyField label="Endpoint URL" value={selectedWebhook.url} />
                    <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Subscribed events</p>
                      <p className="mt-1 text-sm text-text">{selectedWebhook.events.join(", ")}</p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button onClick={() => void handleSendTestWebhook(selectedWebhook.id)} variant="primary">
                        Send test event
                      </Button>
                    </div>
                    <DataTable
                      columns={([
                        { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) },
                        { accessorKey: "event_type", header: "Event" },
                        { accessorKey: "status_code", header: "Status", cell: ({ row }) => row.original.status_code ?? "Pending" },
                        { accessorKey: "attempt", header: "Attempt" },
                        {
                          accessorKey: "event_id",
                          header: "Action",
                          cell: ({ row }) => (
                            <Button
                              onClick={() => void handleReplayWebhookDelivery(row.original)}
                              variant="ghost"
                            >
                              Replay
                            </Button>
                          )
                        }
                      ] as ColumnDef<WebhookDeliveryRow>[]) }
                      data={webhookDeliveriesQuery.data ?? []}
                      emptyState={<EmptyState description="Delivery attempts for this endpoint will appear here." title="No deliveries yet" />}
                      loading={webhookDeliveriesQuery.isLoading}
                      pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                    />
                  </div>
                ) : null}
              </Drawer>
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedLogRequestId(null);
                  }
                }}
                open={Boolean(selectedRequestLog)}
                title="Request log"
              >
                {selectedRequestLog ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Request ID</p>
                        <p className="mt-1 text-sm font-semibold text-text">{selectedRequestLog.request_id}</p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Status</p>
                        <p className="mt-1 text-sm font-semibold text-text">{selectedRequestLog.status_code}</p>
                      </div>
                    </div>
                    <Textarea className="min-h-56 font-mono text-xs" label="Request JSON" readOnly value={formatJson(selectedRequestLog.request_body)} />
                    <Textarea className="min-h-56 font-mono text-xs" label="Response JSON" readOnly value={formatJson(selectedRequestLog.response_body)} />
                  </div>
                ) : null}
              </Drawer>
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedEventId(null);
                  }
                }}
                open={Boolean(selectedOutboxEvent)}
                title="Event payload"
              >
                {selectedOutboxEvent ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Event ID</p>
                        <p className="mt-1 text-sm font-semibold text-text">{selectedOutboxEvent.id}</p>
                      </div>
                      <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Type</p>
                        <p className="mt-1 text-sm font-semibold text-text">{selectedOutboxEvent.type}</p>
                      </div>
                    </div>
                    <Textarea className="min-h-72 font-mono text-xs" label="Payload JSON" readOnly value={formatJson(selectedOutboxEvent.payload)} />
                  </div>
                ) : null}
              </Drawer>
              <Modal onOpenChange={setApiKeyOpen} open={apiKeyOpen} title="Create API key">
                <div className="space-y-4">
                  <Input label="Key name" onChange={(event) => setNewApiKeyName(event.target.value)} value={newApiKeyName} />
                  <Select
                    label="Mode"
                    onValueChange={(value) => setNewApiKeyMode(value as MerchantMode)}
                    options={[
                      { label: "Test", value: "test" },
                      { label: "Live", value: "live" }
                    ]}
                    value={newApiKeyMode}
                  />
                  <Input
                    label="IP allowlist"
                    onChange={(event) => setNewApiKeyIpAllowlist(event.target.value)}
                    placeholder="203.0.113.0/24,198.51.100.10/32"
                    value={newApiKeyIpAllowlist}
                  />
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-text-secondary">Scopes</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {apiKeyScopeOptions.map((scope) => (
                        <Checkbox
                          checked={newApiKeyScopes.includes(scope.value)}
                          key={scope.value}
                          label={scope.label}
                          description={scope.description}
                          onChange={() => toggleApiKeyScope(scope.value)}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-end gap-3">
                    <Button loading={creatingApiKey} onClick={() => void handleCreateApiKey()} variant="primary">
                      Create key
                    </Button>
                  </div>
                </div>
              </Modal>
              <Modal onOpenChange={setWebhookOpen} open={webhookOpen} title="Add webhook endpoint">
                <div className="space-y-4">
                  <Input
                    label="Webhook URL"
                    onChange={(event) => setNewWebhookUrl(event.target.value)}
                    placeholder="https://merchant.example.com/webhooks/richespay"
                    value={newWebhookUrl}
                  />
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-text-secondary">Events</p>
                    <div className="grid gap-3">
                      {webhookEventOptions.map((eventOption) => (
                        <Checkbox
                          checked={newWebhookEvents.includes(eventOption.value)}
                          key={eventOption.value}
                          label={eventOption.label}
                          description={eventOption.description}
                          onChange={() => toggleWebhookEvent(eventOption.value)}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-end gap-3">
                    <Button onClick={() => void handleCreateWebhook()} variant="primary">
                      Save endpoint
                    </Button>
                  </div>
                </div>
              </Modal>
              <Modal
                onOpenChange={(open) => {
                  if (!open) {
                    setApiKeySecret(null);
                  }
                }}
                open={Boolean(apiKeySecret)}
                title="Secret key"
              >
                {apiKeySecret ? (
                  <div className="space-y-4">
                    <div className="rounded-card border border-warning/30 bg-warning/10 p-4 text-sm text-amber-900">
                      <p className="font-semibold">Copy this secret now</p>
                      <p className="mt-1">
                        RichesPay only shows API secrets once. Store it securely before closing this dialog.
                      </p>
                    </div>
                    <CopyField label={`${apiKeySecret.mode === "test" ? "Test" : "Live"} secret`} value={apiKeySecret.key} />
                    {apiKeySecret.previousKeyExpiresAt ? (
                      <p className="text-sm text-text-secondary">
                        The previous key will stop working at {formatDateTime(apiKeySecret.previousKeyExpiresAt, timeZone)}.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </Modal>
              <Modal
                onOpenChange={(open) => {
                  if (!open) {
                    setWebhookSecret(null);
                  }
                }}
                open={Boolean(webhookSecret)}
                title="Webhook signing secret"
              >
                {webhookSecret ? (
                  <div className="space-y-4">
                    <div className="rounded-card border border-warning/30 bg-warning/10 p-4 text-sm text-amber-900">
                      <p className="font-semibold">Copy this signing secret now</p>
                      <p className="mt-1">
                        RichesPay only reveals webhook signing secrets once. Keep it with your endpoint configuration.
                      </p>
                    </div>
                    <CopyField label="Endpoint URL" value={webhookSecret.url} />
                    <CopyField label="Signing secret" value={webhookSecret.signingSecret} />
                  </div>
                ) : null}
              </Modal>
            </>
          ) : null}

          {currentPage === "/settings" ? (
            <>
              <PageHeader subtitle="Business profile, team, security, settlement accounts, and notifications." title="Settings" />
              <Tabs
                items={[
                  {
                    label: "Business",
                    value: "business",
                    content: (
                      <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                        <h3 className="text-lg font-semibold text-text">Business profile</h3>
                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <CopyField label="Merchant ID" value={session.merchant_id} />
                          <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Merchant</p>
                            <p className="mt-1 font-semibold text-text">{session.merchant_name}</p>
                          </div>
                          <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Settlement currency</p>
                            <p className="mt-1 font-semibold text-text">{session.settlement_currency}</p>
                          </div>
                          <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
                            <p className="text-xs uppercase tracking-[0.16em] text-text-muted">Timezone</p>
                            <p className="mt-1 font-semibold text-text">{session.timezone}</p>
                          </div>
                        </div>
                        <div className="mt-5 rounded-card border border-dashed border-border p-4">
                          <p className="font-medium text-text">KYB uploads</p>
                          <p className="mt-1 text-sm text-text-secondary">The KYB dashboard form still needs its upload surface, but the checklist and merchant status are already wired into overview.</p>
                        </div>
                      </section>
                    )
                  },
                  {
                    label: "Team",
                    value: "team",
                    content: (
                      <div className="space-y-4">
                        <div className="flex justify-end">
                          <Button onClick={() => setInviteOpen(true)} variant="primary">
                            Invite teammate
                          </Button>
                        </div>
                        <DataTable
                        columns={([
                          { accessorKey: "full_name", header: "Name", cell: ({ row }) => row.original.full_name ?? "-" },
                          { accessorKey: "email", header: "Email", cell: ({ row }) => row.original.email ?? "-" },
                          { accessorKey: "role", header: "Role" }
                        ] as ColumnDef<TeamMemberRow>[]) }
                        data={teamQuery.data ?? []}
                        emptyState={<EmptyState description="Invite teammates to share access to the dashboard." title="No team members" />}
                        loading={teamQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                        <Modal onOpenChange={setInviteOpen} open={inviteOpen} title="Invite teammate">
                          <div className="space-y-4">
                            <Input label="Email" onChange={(event) => setInviteEmail(event.target.value)} type="email" value={inviteEmail} />
                            <Select
                              label="Role"
                              onValueChange={setInviteRole}
                              options={[
                                { label: "Admin", value: "admin" },
                                { label: "Developer", value: "developer" },
                                { label: "Finance", value: "finance" },
                                { label: "Support", value: "support" },
                                { label: "Viewer", value: "viewer" }
                              ]}
                              value={inviteRole}
                            />
                            <Button
                              loading={inviting}
                              onClick={() => {
                                if (!auth.accessToken || !merchantId || inviting) {
                                  return;
                                }
                                setInviting(true);
                                void apiRequest("/dashboard/v1/team/invite", {
                                  accessToken: auth.accessToken,
                                  body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
                                  merchantId,
                                  method: "POST"
                                })
                                  .then(() => {
                                    setInviteOpen(false);
                                    setInviteEmail("");
                                    pushToast({
                                      description: "The teammate can accept the invite after signing in.",
                                      title: "Invite created",
                                      variant: "success"
                                    });
                                    return queryClient.invalidateQueries({ queryKey: ["dashboard-team"] });
                                  })
                                  .catch((error: unknown) => {
                                    pushToast({
                                      description: error instanceof ApiError ? error.message : "Unable to invite this teammate.",
                                      title: "Invite failed",
                                      variant: "danger"
                                    });
                                  })
                                  .finally(() => setInviting(false));
                              }}
                              variant="primary"
                            >
                              Send invite
                            </Button>
                          </div>
                        </Modal>
                      </div>
                    )
                  },
                  {
                    label: "Security",
                    value: "security",
                    content: (
                      <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                        <h3 className="text-lg font-semibold text-text">Security</h3>
                        <p className="mt-2 text-sm text-text-secondary">
                          Signed in as {session.email ?? "unknown email"} with the {session.role} role. MFA and session management continue to use Supabase Auth.
                        </p>
                      </section>
                    )
                  },
                  {
                    label: "Settlement",
                    value: "settlement",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "type", header: "Type" },
                          { accessorKey: "is_default", header: "Default", cell: ({ row }) => row.original.is_default ? "Yes" : "No" },
                          { accessorKey: "verified_at", header: "Verified", cell: ({ row }) => row.original.verified_at ? formatDateTime(row.original.verified_at, timeZone) : "Pending" }
                        ] as ColumnDef<SettlementAccountRow>[]) }
                        data={settlementAccountsQuery.data ?? []}
                        emptyState={<EmptyState description="Verified settlement accounts appear here." title="No settlement accounts yet" />}
                        loading={settlementAccountsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Products",
                    value: "products",
                    content: (
                      <section className="space-y-4">
                        <p className="text-sm text-text-secondary">
                          Requesting a product follows the same review flow as sign-up. Active products stay available immediately.
                        </p>
                        <div className="grid gap-4 md:grid-cols-2">
                          {([
                            { description: "Accept mobile money and card payments.", key: "collections" as const, title: "Collections" },
                            { description: "Send money to customers.", key: "payouts" as const, title: "Payouts" },
                            { description: "Broadcast from the dashboard or trigger SMS from your app.", key: "sms" as const, title: "SMS" },
                            { description: "Top up mobile numbers from your available balance.", key: "airtime" as const, title: "Send airtime" }
                          ]).map((product) => {
                            const row = (productsCatalogQuery.data ?? []).find((item) => item.key === product.key);
                            const active = row?.active ?? false;
                            const requested = row?.requested ?? false;

                            return (
                              <article className="rounded-card border border-border bg-surface p-5 shadow-softer" key={product.key}>
                                <h3 className="text-lg font-semibold text-text">{product.title}</h3>
                                <p className="mt-1 text-sm text-text-secondary">{product.description}</p>
                                <div className="mt-4">
                                  {active ? (
                                    <StatusBadge status="approved" />
                                  ) : requested ? (
                                    <StatusBadge status="pending" />
                                  ) : (
                                    <Button
                                      loading={requestingProduct === product.key}
                                      onClick={() => void handleProductRequest(product.key)}
                                      variant="secondary"
                                    >
                                      Request
                                    </Button>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    )
                  },
                  {
                    label: "Notifications",
                    value: "notifications",
                    content: (
                      <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                        <h3 className="text-lg font-semibold text-text">Notifications</h3>
                        <p className="mt-2 text-sm text-text-secondary">
                          Email and webhook notification controls live in separate product screens today. This settings panel is ready for the unified preferences layer.
                        </p>
                      </section>
                    )
                  }
                ]}
              />
            </>
          ) : null}

          {currentPage === "/sender-ids" ? (
            <>
              <PageHeader
                action={<Button onClick={() => setSenderIdRequestOpen(true)} variant="primary">Request sender ID</Button>}
                subtitle="Track network approvals, rejected routes, and merchant messaging notifications."
                title="Sender IDs"
              />
              <SummaryCardGrid columns={3}>
                <SummaryCard icon={<ShieldCheck className="size-4" />} label="Approved" value={senderIdQuery.data?.summary.approved ?? 0} />
                <SummaryCard icon={<BookText className="size-4" />} label="Pending" value={senderIdQuery.data?.summary.pending ?? 0} />
                <SummaryCard icon={<Activity className="size-4" />} label="Rejected" value={senderIdQuery.data?.summary.rejected ?? 0} />
              </SummaryCardGrid>
              <Tabs
                items={[
                  {
                    label: "Requests",
                    value: "requests",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "sender_id", header: "Sender ID" },
                          { accessorKey: "purpose", header: "Purpose" },
                          { accessorKey: "approvals", header: "Networks", cell: ({ row }) => row.original.approvals.map((approval) => `${approval.country_code}/${approval.network}`).join(", ") },
                          { accessorKey: "overall_status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.overall_status === "approved" ? "approved" : row.original.overall_status === "rejected" ? "rejected" : "pending") as never} /> },
                          { accessorKey: "created_at", header: "Requested", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) }
                        ] as ColumnDef<SenderIdListData["items"][number]>[]) }
                        data={senderIdQuery.data?.items ?? []}
                        emptyState={<EmptyState description="Request a sender ID to start sending branded SMS." title="No sender IDs yet" />}
                        loading={senderIdQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Notifications",
                    value: "notifications",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "title", header: "Title" },
                          { accessorKey: "body", header: "Message" },
                          { accessorKey: "type", header: "Type" },
                          { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at, timeZone) }
                        ] as ColumnDef<SenderIdListData["notifications"][number]>[]) }
                        data={senderIdQuery.data?.notifications ?? []}
                        emptyState={<EmptyState description="Approval and rejection updates will appear here." title="No sender ID notifications" />}
                        loading={senderIdQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 10 }}
                      />
                    )
                  }
                ]}
              />
              <Modal
                onOpenChange={setSenderIdRequestOpen}
                open={senderIdRequestOpen}
                title="Request sender ID"
              >
                <div className="space-y-4">
                  <Input label="Sender ID" maxLength={11} onChange={(event) => setSenderIdValue(event.target.value.toUpperCase())} value={senderIdValue} />
                  <Select
                    label="Purpose"
                    onValueChange={setSenderIdPurpose}
                    options={[
                      { label: "Transactional", value: "transactional" },
                      { label: "OTP", value: "otp" },
                      { label: "Marketing", value: "marketing" }
                    ]}
                    value={senderIdPurpose}
                  />
                  <Input
                    label="Countries"
                    onChange={(event) => setSenderIdCountries(event.target.value)}
                    placeholder="GH,ZM"
                    value={senderIdCountries}
                  />
                  <Textarea
                    label="Sample message"
                    onChange={(event) => setSenderIdSampleMessage(event.target.value)}
                    value={senderIdSampleMessage}
                  />
                  <Input
                    label="Authorization letter path"
                    onChange={(event) => setSenderIdAuthorizationLetter(event.target.value)}
                    placeholder="private/sender-ids/merchant-letter.pdf"
                    value={senderIdAuthorizationLetter}
                  />
                  <div className="flex justify-end gap-3">
                    <Button onClick={() => void handleCreateSenderId()} variant="primary">
                      Submit request
                    </Button>
                  </div>
                </div>
              </Modal>
            </>
          ) : null}
        </div>
      </AppShell>
    </>
  );
}
