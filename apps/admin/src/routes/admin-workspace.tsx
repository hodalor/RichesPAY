import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookText,
  Building2,
  CircleDollarSign,
  CreditCard,
  Download,
  FileWarning,
  Landmark,
  Search,
  Send,
  ShieldCheck,
  Users
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
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
import { formatMoney } from "@richespay/shared";

import { ApiError, apiRequest } from "../api-client";
import { supabase } from "../supabase";

type AdminRole = "super_admin" | "compliance" | "operations" | "finance" | "support";
type Mode = "test" | "live";
type Currency = "GHS" | "USD" | "ZMW";
type LedgerAccountType =
  | "merchant_available"
  | "merchant_pending"
  | "merchant_reserve"
  | "merchant_payout_hold"
  | "merchant_airtime_hold"
  | "platform_fees"
  | "platform_sms_revenue"
  | "provider_clearing"
  | "fx_clearing"
  | "suspense";

const currencyOptions: Array<{ label: string; value: Currency }> = [
  { label: "GHS", value: "GHS" },
  { label: "USD", value: "USD" },
  { label: "ZMW", value: "ZMW" }
];

const ledgerAccountTypeOptions: Array<{ label: string; value: LedgerAccountType }> = [
  { label: "Merchant available", value: "merchant_available" },
  { label: "Merchant pending", value: "merchant_pending" },
  { label: "Merchant reserve", value: "merchant_reserve" },
  { label: "Merchant payout hold", value: "merchant_payout_hold" },
  { label: "Merchant airtime hold", value: "merchant_airtime_hold" },
  { label: "Platform fees", value: "platform_fees" },
  { label: "Platform SMS revenue", value: "platform_sms_revenue" },
  { label: "Provider clearing", value: "provider_clearing" },
  { label: "FX clearing", value: "fx_clearing" },
  { label: "Suspense", value: "suspense" }
];

interface AdminSessionData {
  email: string | null;
  role: AdminRole;
  user_id: string;
}

interface OverviewData {
  active_merchants: number;
  airtime_volume_today_minor: number;
  channel_health: Array<{
    channel_id: string;
    country_code: string;
    health: "healthy" | "degraded" | "down";
    kind: "mobile_money" | "card" | "sms" | "bank" | "airtime";
    mode: Mode;
    network: string | null;
    provider_code: string;
    status: "active" | "disabled" | "maintenance";
  }>;
  low_float_channels: Array<{
    balance_minor: number | null;
    channel_id: string;
    country_code: string;
    currency: string | null;
    network: string | null;
    provider_code: string;
    status: "ok" | "low" | "empty" | "unknown";
    threshold_minor: number | null;
  }>;
  open_exceptions: number;
  platform_volume_today_minor: number;
  success_rate_by_channel: Array<{
    channel_id: string;
    provider_code: string;
    success_rate: number;
    successful_count: number;
    total_count: number;
  }>;
}

interface MerchantListRow {
  collections_frozen: boolean;
  country_code: string;
  created_at: string;
  id: string;
  mode: Mode;
  name: string;
  payouts_frozen: boolean;
  settlement_currency: string;
  status: "active" | "closed" | "pending_kyb" | "suspended";
  today_volume_minor: number;
  trading_name: string | null;
}

interface MerchantDetailData {
  collections_frozen: boolean;
  compliance: {
    collections_freeze_category: string | null;
    contact_link: string;
    kyb_tier: string;
    payouts_freeze_category: string | null;
    suspension_category: string | null;
    suspension_reason: string | null;
  };
  country_code: string;
  created_at: string;
  id: string;
  legal_name: string;
  mode: Mode;
  payouts_frozen: boolean;
  products: {
    airtime_enabled: boolean;
    airtime_requested: boolean;
    collections_enabled: boolean;
    collections_requested: boolean;
    payouts_enabled: boolean;
    payouts_requested: boolean;
    sms_api_enabled: boolean;
    sms_broadcast_enabled: boolean;
    sms_enabled: boolean;
    sms_requested: boolean;
  };
  settlement_currency: string;
  status: "active" | "closed" | "pending_kyb" | "suspended";
  support_email: string | null;
  support_phone: string | null;
  timezone: string;
  trading_name: string | null;
  website: string | null;
}

interface MerchantComplianceData {
  collections_freeze_category: string | null;
  collections_freeze_reason: string | null;
  collections_frozen: boolean;
  contact_link: string;
  kyb_tier: string;
  limits: {
    collection: {
      daily_volume_minor: number | null;
      max_minor: number;
      min_minor: number;
      monthly_volume_minor: number | null;
    };
    payout: {
      daily_volume_minor: number | null;
      max_minor: number;
      min_minor: number;
      monthly_volume_minor: number | null;
    };
  };
  merchant_id: string;
  mode: Mode;
  payouts_freeze_category: string | null;
  payouts_freeze_reason: string | null;
  payouts_frozen: boolean;
  rolling_reserve_bps: number;
  rolling_reserve_days: number;
  screening_payout_threshold_minor: number | null;
  settlement_currency: "GHS" | "USD" | "ZMW";
  status: string;
  suspension_category: string | null;
  suspension_reason: string | null;
  velocity_collections_per_phone: number;
  velocity_window_minutes: number;
}

interface MerchantKybData {
  documents: Array<{
    created_at: string;
    document_type: string;
    file_path: string;
    id: string;
    review_note: string | null;
    reviewer_id: string | null;
    status: "approved" | "pending" | "rejected";
    updated_at: string;
  }>;
  profile: {
    business_registration_number: string | null;
    registered_address: string | null;
    review_note: string | null;
    reviewer_id: string | null;
    status: "approved" | "pending" | "rejected";
    tax_id: string | null;
  } | null;
}

interface MerchantBalanceRow {
  account_id: string;
  balance_minor: number;
  channel_id: string | null;
  currency: string;
  type: string;
}

interface MerchantCollectionRow {
  amount: number;
  created_at: string;
  currency: string;
  id: string;
  method: string;
  phone: string | null;
  provider_ref: string | null;
  reference: string | null;
  status: string;
}

type MerchantPayoutRow = MerchantCollectionRow;

interface MerchantSmsRow {
  created_at: string;
  id: string;
  price_minor: number;
  recipient: string;
  sender_id: string;
  status: string;
  type: string;
}

interface MerchantTeamRow {
  email: string | null;
  full_name: string | null;
  role: string;
  user_id: string;
}

interface MerchantFreezeHistoryRow {
  action: string;
  actor_id: string | null;
  created_at: string;
  freeze_type: string;
  id: string;
  reason: string | null;
}

interface AuditLogRow {
  action: string;
  actor_id: string;
  actor_type: string;
  created_at: string;
  id: string;
  merchant_id: string | null;
  mode: Mode;
  reason: string | null;
  target_id: string | null;
  target_type: string;
}

interface MerchantPricingData {
  default_fee_plans: FeePlanRow[];
  merchant_overrides: MerchantOverrideRow[];
}

interface KybQueueRow {
  created_at: string;
  merchant_id: string;
  merchant_name: string;
  mode: Mode;
  pending_document_count: number;
  review_note: string | null;
  status: "approved" | "pending" | "rejected";
  updated_at: string;
}

interface ComplianceFlagRow {
  created_at: string;
  id: string;
  merchant_id: string;
  mode: Mode;
  payload: unknown;
  resource_id: string;
  resource_type: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rule_code: string;
  status: "open" | "resolved" | "dismissed";
  summary: string;
}

interface ChannelRow {
  capabilities: string[];
  config: unknown;
  country_code: string;
  created_at: string;
  has_credentials: boolean;
  health: "healthy" | "degraded" | "down";
  id: string;
  kind: "mobile_money" | "card" | "sms" | "bank" | "airtime";
  mode: Mode;
  network: string | null;
  priority: number;
  provider_code: string;
  status: "active" | "disabled" | "maintenance";
  updated_at: string;
}

interface AirtimeNetworkAdminRow {
  active: boolean;
  country_code: string;
  currency: string;
  fixed_denominations: number[] | null;
  max_amount: number;
  min_amount: number;
  network: string;
  updated_at: string;
}

interface AirtimeDiscountPlanRow {
  active: boolean;
  country_code: string;
  discount_bps: number;
  id: string;
  merchant_id: string | null;
  mode: Mode | null;
  network: string;
  updated_at: string;
}

interface AirtimeFloatRow {
  balance_minor: number | null;
  channel_id: string;
  checked_at: string | null;
  country_code: string;
  currency: string | null;
  network: string | null;
  provider_code: string;
  status: "ok" | "low" | "empty" | "unknown";
  threshold_minor: number | null;
}

interface AirtimeFloatHistoryRow {
  balance_minor: number | null;
  channel_id: string;
  checked_at: string;
  currency: string | null;
  id: string;
  status: "ok" | "low" | "empty" | "unknown";
  threshold_minor: number;
}

interface AirtimeOrderAdminRow {
  amount: number;
  charge_amount: number;
  charge_currency: string;
  country_code: string;
  created_at: string;
  currency: string;
  id: string;
  merchant_id: string;
  mode: Mode;
  network: string;
  phone: string;
  provider_ref: string | null;
  reference: string | null;
  status: string;
}

interface AirtimeMerchantTabData {
  orders: AirtimeOrderAdminRow[];
  spend: {
    month_charge_minor: number;
    month_count: number;
    today_charge_minor: number;
    today_count: number;
    today_successful_count: number;
  };
}

interface AirtimeLimitsRow {
  merchant_daily_cap_minor: number;
  merchant_id: string;
  mode: Mode;
  number_daily_cap_minor: number;
  uses_defaults: boolean;
  velocity_per_number: number;
}

interface RoutingRuleRow {
  capability: "collect" | "payout" | "sms" | "airtime";
  channel_ids: string[];
  country_code: string;
  id: string;
  kind: "mobile_money" | "card" | "sms" | "bank" | "airtime";
  network: string | null;
}

interface TransactionSearchRow {
  amount_minor: number | null;
  created_at: string;
  id: string;
  merchant_id: string;
  mode: Mode;
  provider_ref: string | null;
  reference: string | null;
  resource_type: "collection" | "payout" | "sms" | "airtime";
  status: string;
}

interface ReconSummaryRow {
  balances_match: boolean;
  channel_id: string;
  collection_count: number;
  collection_volume: number;
  created_at: string;
  currency: string;
  exception_count: number;
  fee_volume: number;
  id: string;
  payout_count: number;
  payout_volume: number;
  provider_clearing_balance: number;
  provider_float_balance: number | null;
  statement_date: string;
  statement_id: string;
}

interface ReconExceptionRow {
  channel_id: string;
  created_at: string;
  currency: string | null;
  exception_type: "missing_in_richespay" | "missing_at_provider" | "amount_mismatch" | "status_mismatch";
  expected_amount: number | null;
  expected_status: string | null;
  id: string;
  merchant_id: string | null;
  mode: Mode | null;
  provider_amount: number | null;
  provider_ref: string | null;
  provider_status: string | null;
  resolution_action: "force_status" | "manual_adjustment" | "dismiss" | null;
  resolution_reason: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resource_id: string | null;
  resource_type: string | null;
  statement_id: string | null;
  statement_line_id: string | null;
  status: "open" | "resolved" | "dismissed";
}

interface SenderIdQueueRow {
  approval_id: string;
  authorization_letter: string;
  country_code: string;
  created_at: string;
  merchant_id: string;
  merchant_name: string;
  mode: Mode;
  network: string;
  overall_status: "approved" | "pending" | "rejected";
  purpose: "transactional" | "otp" | "marketing";
  rejection_reason: string | null;
  sample_message: string;
  sender_id: string;
  sender_id_id: string;
  status: "pending" | "submitted" | "approved" | "rejected";
  updated_at: string;
  updated_by: string;
}

interface PlatformSmsSettings {
  created_at: string;
  default_otp_sender_id: string | null;
  mode: Mode;
  updated_at: string;
  updated_by: string;
}

interface FeePlanRow {
  active: boolean;
  country_code: string;
  currency: string;
  fee_bearer: string;
  fixed_minor: number;
  id: string;
  kind: string;
  max_minor: number | null;
  method: string;
  min_minor: number;
  name: string;
  network: string | null;
  percent_bps: number;
}

interface MerchantOverrideRow extends Omit<FeePlanRow, "country_code"> {
  merchant_id: string;
  mode: Mode;
  updated_at: string;
}

interface FxRateRow {
  active: boolean;
  base: string;
  captured_at: string;
  id: string;
  markup_bps: number;
  quote: string;
  rate: string;
  source: string;
}

interface AdminUserRow {
  active: boolean;
  created_at: string;
  email: string | null;
  full_name: string | null;
  role: AdminRole;
  updated_at: string;
  user_id: string;
}

interface AdminWorkspaceProps {
  accessToken: string;
  sessionData: AdminSessionData;
  onSignOutEverywhere: () => Promise<void>;
}

function parseDenominations(value: string): number[] | null {
  const amounts = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((amount) => Number.isInteger(amount) && amount > 0);
  return amounts.length > 0 ? amounts : null;
}

function airtimeFloatBadge(status: AirtimeFloatRow["status"]) {
  if (status === "ok") return "successful" as const;
  if (status === "empty") return "failed" as const;
  return "pending" as const;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function formatAdminMoney(amountMinor: number | bigint | null | undefined, currency: string | undefined) {
  if (amountMinor === null || amountMinor === undefined) {
    return "-";
  }

  if (currency !== "GHS" && currency !== "USD" && currency !== "ZMW") {
    return "-";
  }

  return formatMoney(BigInt(amountMinor), currency, "en-GH");
}

function makeDateRangeValue(): DateRangeValue {
  return { preset: "thirty_days" };
}

function dateRangeToQuery(value: DateRangeValue) {
  const today = new Date();
  const format = (date: Date) => date.toISOString().slice(0, 10);

  switch (value.preset) {
    case "today":
      return { end_date: format(today), start_date: format(today) };
    case "seven_days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { end_date: format(today), start_date: format(start) };
    }
    case "thirty_days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { end_date: format(today), start_date: format(start) };
    }
    case "this_month": {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      return { end_date: format(today), start_date: format(start) };
    }
    case "custom":
      return {
        ...(value.startDate ? { start_date: value.startDate } : {}),
        ...(value.endDate ? { end_date: value.endDate } : {})
      };
    default:
      return {};
  }
}

function exportCsv(fileName: string, headers: string[], rows: Array<Array<string | number | boolean | null>>) {
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      row
        .map((value) => {
          const text = value === null ? "" : String(value);
          return `"${text.replaceAll("\"", "\"\"")}"`
        })
        .join(",")
    )
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function confirmAdminTotp(code: string) {
  const { data, error: listError } = await supabase.auth.mfa.listFactors();
  const factor = data?.totp[0];

  if (listError || !factor) {
    throw new Error("This admin user does not have a TOTP factor enrolled.");
  }

  const { data: challenge, error: challengeError } =
    await supabase.auth.mfa.challenge({ factorId: factor.id });

  if (challengeError || !challenge) {
    throw new Error(challengeError?.message ?? "Unable to challenge the admin factor.");
  }

  const { error } = await supabase.auth.mfa.verify({
    challengeId: challenge.id,
    code,
    factorId: factor.id
  });

  if (error) {
    throw new Error(error.message);
  }
}

export function AdminWorkspace({
  accessToken,
  onSignOutEverywhere,
  sessionData
}: AdminWorkspaceProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const selectedMerchantId = params.merchantId ?? null;

  const [merchantMode, setMerchantMode] = React.useState<Mode>("live");
  const [merchantStatusFilter, setMerchantStatusFilter] = React.useState("");
  const [merchantCountryFilter, setMerchantCountryFilter] = React.useState("");
  const [merchantSearch, setMerchantSearch] = React.useState("");
  const [globalModeFilter, setGlobalModeFilter] = React.useState("");
  const [dateRange, setDateRange] = React.useState<DateRangeValue>(makeDateRangeValue());
  const [transactionSearch, setTransactionSearch] = React.useState("");
  const [auditActorFilter, setAuditActorFilter] = React.useState("");
  const [auditActionFilter, setAuditActionFilter] = React.useState("");
  const [selectedFlag, setSelectedFlag] = React.useState<ComplianceFlagRow | null>(null);
  const [selectedChannel, setSelectedChannel] = React.useState<ChannelRow | null>(null);
  const [selectedRule, setSelectedRule] = React.useState<RoutingRuleRow | null>(null);
  const [selectedException, setSelectedException] = React.useState<ReconExceptionRow | null>(null);
  const [selectedSenderIdRow, setSelectedSenderIdRow] = React.useState<SenderIdQueueRow | null>(null);
  const [selectedAuditRow, setSelectedAuditRow] = React.useState<AuditLogRow | null>(null);
  const [kybReviewTarget, setKybReviewTarget] = React.useState<KybQueueRow | null>(null);
  const [kybReviewStatus, setKybReviewStatus] = React.useState<"approved" | "pending" | "rejected">("approved");
  const [kybReviewNote, setKybReviewNote] = React.useState("");
  const [adminUserOpen, setAdminUserOpen] = React.useState(false);
  const [fxModalOpen, setFxModalOpen] = React.useState(false);
  const [fxBase, setFxBase] = React.useState("GHS");
  const [fxQuote, setFxQuote] = React.useState("USD");
  const [fxRate, setFxRate] = React.useState("1.00");
  const [fxMarkup, setFxMarkup] = React.useState("0");
  const [fxReason, setFxReason] = React.useState("");
  const [fxCode, setFxCode] = React.useState("");
  const [routeReason, setRouteReason] = React.useState("");
  const [routeCode, setRouteCode] = React.useState("");
  const [routeChannelOrder, setRouteChannelOrder] = React.useState<string[]>([]);
  const [draggedRouteChannelId, setDraggedRouteChannelId] = React.useState<string | null>(null);
  const [forceStatusValue, setForceStatusValue] = React.useState("successful");
  const [resolveReason, setResolveReason] = React.useState("");
  const [manualAdjustmentAmount, setManualAdjustmentAmount] = React.useState("");
  const [manualAdjustmentCurrency, setManualAdjustmentCurrency] = React.useState<Currency>("GHS");
  const [manualAdjustmentCode, setManualAdjustmentCode] = React.useState("");
  const [manualDebitType, setManualDebitType] = React.useState<LedgerAccountType>("provider_clearing");
  const [manualDebitMerchantId, setManualDebitMerchantId] = React.useState("");
  const [manualDebitChannelId, setManualDebitChannelId] = React.useState("");
  const [manualCreditType, setManualCreditType] = React.useState<LedgerAccountType>("suspense");
  const [manualCreditMerchantId, setManualCreditMerchantId] = React.useState("");
  const [manualCreditChannelId, setManualCreditChannelId] = React.useState("");
  const [senderIdStatusFilter, setSenderIdStatusFilter] = React.useState("");
  const [senderIdCountryFilter, setSenderIdCountryFilter] = React.useState("");
  const [senderIdNetworkFilter, setSenderIdNetworkFilter] = React.useState("");
  const [settingsMode, setSettingsMode] = React.useState<Mode>("live");
  const [airtimeNetworkDraft, setAirtimeNetworkDraft] = React.useState<AirtimeNetworkAdminRow | null>(null);
  const [airtimeNetworkMin, setAirtimeNetworkMin] = React.useState("");
  const [airtimeNetworkMax, setAirtimeNetworkMax] = React.useState("");
  const [airtimeNetworkActive, setAirtimeNetworkActive] = React.useState(true);
  const [airtimeNetworkReason, setAirtimeNetworkReason] = React.useState("");
  const [airtimeNetworkDenoms, setAirtimeNetworkDenoms] = React.useState("");
  const [airtimeDiscountCountry, setAirtimeDiscountCountry] = React.useState("ZM");
  const [airtimeDiscountNetwork, setAirtimeDiscountNetwork] = React.useState("MTN");
  const [airtimeDiscountBps, setAirtimeDiscountBps] = React.useState("300");
  const [airtimeDiscountReason, setAirtimeDiscountReason] = React.useState("");
  const [airtimeOverrideMerchantId, setAirtimeOverrideMerchantId] = React.useState("");
  const [airtimeOverrideMode, setAirtimeOverrideMode] = React.useState<Mode>("live");
  const [airtimeOverrideCountry, setAirtimeOverrideCountry] = React.useState("ZM");
  const [airtimeOverrideNetwork, setAirtimeOverrideNetwork] = React.useState("MTN");
  const [airtimeOverrideBps, setAirtimeOverrideBps] = React.useState("300");
  const [airtimeOverrideReason, setAirtimeOverrideReason] = React.useState("");
  const [airtimeSaving, setAirtimeSaving] = React.useState(false);
  const [airtimeOrderSearch, setAirtimeOrderSearch] = React.useState("");
  const [airtimeOrderMode, setAirtimeOrderMode] = React.useState("");
  const [selectedAirtimeFloat, setSelectedAirtimeFloat] = React.useState<AirtimeFloatRow | null>(null);
  const [airtimeFloatThreshold, setAirtimeFloatThreshold] = React.useState("");
  const [airtimeFloatReason, setAirtimeFloatReason] = React.useState("");
  const [selectedAirtimeOrder, setSelectedAirtimeOrder] = React.useState<AirtimeOrderAdminRow | null>(null);
  const [channelKindFilter, setChannelKindFilter] = React.useState("");
  const [flagRuleFilter, setFlagRuleFilter] = React.useState("");
  const [flagSearch, setFlagSearch] = React.useState("");
  const [defaultOtpSenderId, setDefaultOtpSenderId] = React.useState("");
  const [senderQueueActionType, setSenderQueueActionType] = React.useState<"submit" | "approve" | "reject" | null>(null);
  const [senderQueueReason, setSenderQueueReason] = React.useState("");
  const [senderQueueCode, setSenderQueueCode] = React.useState("");
  const [freezeCode, setFreezeCode] = React.useState("");
  const [freezeCategory, setFreezeCategory] = React.useState("operations");

  const currentPage = React.useMemo(() => {
    if (selectedMerchantId) {
      return "merchant-detail";
    }
    if (location.pathname.includes("/kyb")) return "kyb";
    if (location.pathname.includes("/compliance-flags")) return "compliance-flags";
    if (location.pathname.includes("/channels")) return "channels";
    if (location.pathname.includes("/transactions")) return "transactions";
    if (location.pathname.includes("/reconciliation")) return "reconciliation";
    if (location.pathname.includes("/sender-ids")) return "sender-ids";
    if (location.pathname.includes("/airtime")) return "airtime";
    if (location.pathname.includes("/pricing")) return "pricing";
    if (location.pathname.includes("/admin-users")) return "admin-users";
    if (location.pathname.includes("/audit")) return "audit";
    if (location.pathname.includes("/merchants")) return "merchants";
    return "overview";
  }, [location.pathname, selectedMerchantId]);

  const overviewQuery = useQuery({
    enabled: currentPage === "overview",
    queryKey: ["admin-overview", accessToken],
    queryFn: () =>
      apiRequest<OverviewData>("/admin/v1/overview", {
        accessToken
      })
  });

  const merchantsQuery = useQuery({
    enabled: currentPage === "merchants",
    queryKey: ["admin-merchants", accessToken, merchantStatusFilter, merchantCountryFilter, merchantSearch, globalModeFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (merchantStatusFilter) params.set("status", merchantStatusFilter);
      if (merchantCountryFilter) params.set("country_code", merchantCountryFilter);
      if (merchantSearch) params.set("search", merchantSearch);
      if (globalModeFilter) params.set("mode", globalModeFilter);
      return apiRequest<MerchantListRow[]>(`/admin/v1/merchants?${params.toString()}`, {
        accessToken
      });
    }
  });

  const merchantDetailQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-detail", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantDetailData>(`/admin/v1/merchants/${selectedMerchantId}?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantComplianceQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-compliance", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantComplianceData>(`/admin/v1/merchants/${selectedMerchantId}/compliance?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantKybQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-kyb", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantKybData>(`/admin/v1/merchants/${selectedMerchantId}/kyb?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantBalancesQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-balances", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantBalanceRow[]>(`/admin/v1/merchants/${selectedMerchantId}/balances?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantCollectionsQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-collections", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantCollectionRow[]>(`/admin/v1/merchants/${selectedMerchantId}/collections?mode=${merchantMode}&limit=20`, {
        accessToken
      })
  });

  const merchantPayoutsQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-payouts", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantPayoutRow[]>(`/admin/v1/merchants/${selectedMerchantId}/payouts?mode=${merchantMode}&limit=20`, {
        accessToken
      })
  });

  const merchantSmsQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-sms", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantSmsRow[]>(`/admin/v1/merchants/${selectedMerchantId}/sms?mode=${merchantMode}&limit=20`, {
        accessToken
      })
  });

  const merchantAirtimeQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-airtime", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<AirtimeMerchantTabData>(`/admin/v1/merchants/${selectedMerchantId}/airtime?mode=${merchantMode}&limit=20`, {
        accessToken
      })
  });

  const merchantAirtimeLimitsQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-airtime-limits", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<AirtimeLimitsRow>(`/admin/v1/merchants/${selectedMerchantId}/airtime-limits?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantTeamQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-team", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantTeamRow[]>(`/admin/v1/merchants/${selectedMerchantId}/team?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantFreezeHistoryQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-freeze-history", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantFreezeHistoryRow[]>(`/admin/v1/merchants/${selectedMerchantId}/freeze-history?mode=${merchantMode}`, {
        accessToken
      })
  });

  const merchantAuditQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-audit", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<AuditLogRow[]>(`/admin/v1/merchants/${selectedMerchantId}/audit?mode=${merchantMode}&limit=50`, {
        accessToken
      })
  });

  const merchantPricingQuery = useQuery({
    enabled: Boolean(selectedMerchantId),
    queryKey: ["admin-merchant-pricing", accessToken, selectedMerchantId, merchantMode],
    queryFn: () =>
      apiRequest<MerchantPricingData>(`/admin/v1/merchants/${selectedMerchantId}/pricing?mode=${merchantMode}`, {
        accessToken
      })
  });

  const kybQueueQuery = useQuery({
    enabled: currentPage === "kyb",
    queryKey: ["admin-kyb-queue", accessToken, globalModeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
      if (globalModeFilter) params.set("mode", globalModeFilter);
      return apiRequest<KybQueueRow[]>(`/admin/v1/kyb/review-queue?${params.toString()}`, {
        accessToken
      });
    }
  });

  const flagsQuery = useQuery({
    enabled: currentPage === "compliance-flags",
    queryKey: ["admin-review-flags", accessToken],
    queryFn: () =>
      apiRequest<ComplianceFlagRow[]>("/admin/v1/compliance/review-flags?limit=50&status=open", {
        accessToken
      })
  });

  const channelsQuery = useQuery({
    enabled: currentPage === "channels" || currentPage === "overview",
    queryKey: ["admin-channels", accessToken],
    queryFn: () => apiRequest<ChannelRow[]>("/admin/v1/channels", { accessToken })
  });

  const routingRulesQuery = useQuery({
    enabled: currentPage === "channels",
    queryKey: ["admin-routing-rules", accessToken],
    queryFn: () => apiRequest<RoutingRuleRow[]>("/admin/v1/routing-rules", { accessToken })
  });

  const transactionSearchQuery = useQuery({
    enabled: currentPage === "transactions" && transactionSearch.trim().length > 0,
    queryKey: ["admin-transaction-search", accessToken, transactionSearch, globalModeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "30", q: transactionSearch });
      if (globalModeFilter) params.set("mode", globalModeFilter);
      return apiRequest<TransactionSearchRow[]>(`/admin/v1/transactions/search?${params.toString()}`, {
        accessToken
      });
    }
  });

  const reconciliationSummariesQuery = useQuery({
    enabled: currentPage === "reconciliation",
    queryKey: ["admin-reconciliation-summaries", accessToken],
    queryFn: () => apiRequest<ReconSummaryRow[]>("/admin/v1/reconciliation/summaries?limit=20", { accessToken })
  });

  const reconciliationExceptionsQuery = useQuery({
    enabled: currentPage === "reconciliation",
    queryKey: ["admin-reconciliation-exceptions", accessToken],
    queryFn: () => apiRequest<ReconExceptionRow[]>("/admin/v1/reconciliation/exceptions?limit=50&status=open", { accessToken })
  });

  const senderIdsQuery = useQuery({
    enabled: currentPage === "sender-ids",
    queryKey: ["admin-sender-ids", accessToken, senderIdStatusFilter, senderIdCountryFilter, senderIdNetworkFilter, globalModeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "200" });
      if (senderIdStatusFilter) params.set("status", senderIdStatusFilter);
      if (senderIdCountryFilter) params.set("country_code", senderIdCountryFilter.toUpperCase());
      if (senderIdNetworkFilter) params.set("network", senderIdNetworkFilter);
      if (globalModeFilter) params.set("mode", globalModeFilter);
      return apiRequest<SenderIdQueueRow[]>(`/admin/v1/sms/sender-ids/queue?${params.toString()}`, {
        accessToken
      });
    }
  });

  const platformSettingsQuery = useQuery({
    enabled: currentPage === "sender-ids",
    queryKey: ["admin-platform-sms-settings", accessToken, settingsMode],
    queryFn: () =>
      apiRequest<PlatformSmsSettings>(`/admin/v1/sms/platform-settings/${settingsMode}`, {
        accessToken
      })
  });

  const airtimeNetworksQuery = useQuery({
    enabled: currentPage === "airtime",
    queryKey: ["admin-airtime-networks", accessToken],
    queryFn: () => apiRequest<AirtimeNetworkAdminRow[]>("/admin/v1/airtime/networks", { accessToken })
  });

  const airtimeDiscountPlansQuery = useQuery({
    enabled: currentPage === "airtime",
    queryKey: ["admin-airtime-discount-plans", accessToken],
    queryFn: () => apiRequest<AirtimeDiscountPlanRow[]>("/admin/v1/airtime/discount-plans", { accessToken })
  });

  const airtimeDiscountOverridesQuery = useQuery({
    enabled: currentPage === "airtime",
    queryKey: ["admin-airtime-discount-overrides", accessToken],
    queryFn: () => apiRequest<AirtimeDiscountPlanRow[]>("/admin/v1/airtime/discount-plans?scope=overrides", { accessToken })
  });

  const airtimeFloatsQuery = useQuery({
    enabled: currentPage === "airtime",
    queryKey: ["admin-airtime-floats", accessToken],
    queryFn: () => apiRequest<AirtimeFloatRow[]>("/admin/v1/airtime/floats", { accessToken })
  });

  const airtimeFloatHistoryQuery = useQuery({
    enabled: Boolean(selectedAirtimeFloat),
    queryKey: ["admin-airtime-float-history", accessToken, selectedAirtimeFloat?.channel_id],
    queryFn: () =>
      apiRequest<AirtimeFloatHistoryRow[]>(`/admin/v1/airtime/floats/${selectedAirtimeFloat?.channel_id}/history?limit=48`, {
        accessToken
      })
  });

  const airtimeOrdersQuery = useQuery({
    enabled: currentPage === "airtime",
    queryKey: ["admin-airtime-orders", accessToken, airtimeOrderSearch, airtimeOrderMode],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
      if (airtimeOrderSearch.trim()) params.set("q", airtimeOrderSearch.trim());
      if (airtimeOrderMode) params.set("mode", airtimeOrderMode);
      return apiRequest<AirtimeOrderAdminRow[]>(`/admin/v1/airtime/orders?${params.toString()}`, { accessToken });
    }
  });

  const feePlansQuery = useQuery({
    enabled: currentPage === "pricing",
    queryKey: ["admin-fee-plans", accessToken],
    queryFn: () => apiRequest<FeePlanRow[]>("/admin/v1/pricing/fee-plans", { accessToken })
  });

  const merchantOverridesQuery = useQuery({
    enabled: currentPage === "pricing",
    queryKey: ["admin-merchant-overrides", accessToken],
    queryFn: () => apiRequest<MerchantOverrideRow[]>("/admin/v1/pricing/merchant-overrides", { accessToken })
  });

  const fxRatesQuery = useQuery({
    enabled: currentPage === "pricing",
    queryKey: ["admin-fx-rates", accessToken],
    queryFn: () => apiRequest<FxRateRow[]>("/admin/v1/pricing/fx-rates", { accessToken })
  });

  const adminUsersQuery = useQuery({
    enabled: currentPage === "admin-users",
    queryKey: ["admin-users", accessToken],
    queryFn: () => apiRequest<AdminUserRow[]>("/admin/v1/admin-users", { accessToken })
  });

  const auditQuery = useQuery({
    enabled: currentPage === "audit",
    queryKey: ["admin-audit", accessToken, auditActorFilter, auditActionFilter, dateRange],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
      const range = dateRangeToQuery(dateRange);
      if (auditActorFilter) params.set("actor_id", auditActorFilter);
      if (auditActionFilter) params.set("action", auditActionFilter);
      if (range.start_date) params.set("start_date", range.start_date);
      if (range.end_date) params.set("end_date", range.end_date);
      return apiRequest<AuditLogRow[]>(`/admin/v1/audit-logs?${params.toString()}`, { accessToken });
    }
  });

  React.useEffect(() => {
    if (platformSettingsQuery.data) {
      setDefaultOtpSenderId(platformSettingsQuery.data.default_otp_sender_id ?? "");
    }
  }, [platformSettingsQuery.data]);

  const navSections = React.useMemo<SidebarSection[]>(
    () => [
      {
        label: "Overview",
        items: [{ href: "/app/overview", icon: <Activity className="size-4" />, label: "Overview" }]
      },
      {
        label: "Operations",
        items: [
          { href: "/app/merchants", icon: <Building2 className="size-4" />, label: "Merchants" },
          { href: "/app/kyb", icon: <ShieldCheck className="size-4" />, label: "KYB Queue" },
          { href: "/app/compliance-flags", icon: <AlertTriangle className="size-4" />, label: "Compliance" },
          { href: "/app/transactions", icon: <Search className="size-4" />, label: "Transactions" },
          { href: "/app/reconciliation", icon: <FileWarning className="size-4" />, label: "Reconciliation" }
        ]
      },
      {
        label: "Platform",
        items: [
          { href: "/app/channels", icon: <Landmark className="size-4" />, label: "Channels" },
          { href: "/app/sender-ids", icon: <Send className="size-4" />, label: "Sender IDs" },
          { href: "/app/airtime", icon: <CreditCard className="size-4" />, label: "Airtime" },
          { href: "/app/pricing", icon: <CircleDollarSign className="size-4" />, label: "Pricing & FX" },
          { href: "/app/admin-users", icon: <Users className="size-4" />, label: "Admin Users" },
          { href: "/app/audit", icon: <BookText className="size-4" />, label: "Audit" }
        ]
      }
    ],
    []
  );

  async function runSensitiveAction(input: {
    code: string;
    task: () => Promise<void>;
  }) {
    try {
      await confirmAdminTotp(input.code);
      await input.task();
    } catch (error) {
      pushToast({
        description: error instanceof Error ? error.message : "The sensitive action could not be completed.",
        title: "Action failed",
        variant: "danger"
      });
    }
  }

  async function refreshMerchantDetail() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-merchant-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-merchant-compliance"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-merchant-freeze-history"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-merchant-audit"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-merchants"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-merchant-airtime"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-merchant-airtime-limits"] })
    ]);
  }

  const selectedRuleChannels = React.useMemo(() => {
    if (!selectedRule || !channelsQuery.data) {
      return [];
    }

    return routeChannelOrder
      .map((id) => channelsQuery.data.find((channel) => channel.id === id))
      .filter((channel): channel is ChannelRow => Boolean(channel));
  }, [channelsQuery.data, routeChannelOrder, selectedRule]);

  React.useEffect(() => {
    if (!selectedRule) {
      setRouteChannelOrder([]);
      setDraggedRouteChannelId(null);
      return;
    }

    setRouteChannelOrder(selectedRule.channel_ids);
  }, [selectedRule]);

  React.useEffect(() => {
    setManualAdjustmentCurrency((selectedException?.currency as Currency | null) ?? "GHS");
    setManualDebitMerchantId(selectedException?.merchant_id ?? "");
    setManualCreditMerchantId(selectedException?.merchant_id ?? "");
    setManualDebitChannelId(selectedException?.channel_id ?? "");
    setManualCreditChannelId(selectedException?.channel_id ?? "");
  }, [selectedException]);

  const moveRouteChannel = React.useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) {
      return;
    }

    setRouteChannelOrder((current) => {
      const next = current.filter((id) => id !== draggedId);
      const targetIndex = next.indexOf(targetId);

      if (targetIndex === -1) {
        return current;
      }

      next.splice(targetIndex, 0, draggedId);
      return next;
    });
  }, []);

  const filteredChannels = React.useMemo(() => {
    const rows = channelsQuery.data ?? [];
    return channelKindFilter ? rows.filter((row) => row.kind === channelKindFilter) : rows;
  }, [channelKindFilter, channelsQuery.data]);

  const filteredFlags = React.useMemo(() => {
    const query = flagSearch.trim().toLowerCase();
    return (flagsQuery.data ?? []).filter((row) => {
      if (flagRuleFilter && row.rule_code !== flagRuleFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        row.rule_code.toLowerCase().includes(query) ||
        row.merchant_id.toLowerCase().includes(query) ||
        row.summary.toLowerCase().includes(query)
      );
    });
  }, [flagRuleFilter, flagSearch, flagsQuery.data]);

  const airtimeFloatSummary = React.useMemo(() => {
    const rows = airtimeFloatsQuery.data ?? [];
    return {
      below: rows.filter((row) => row.status === "low" || row.status === "empty").length,
      empty: rows.filter((row) => row.status === "empty").length,
      total: rows.length
    };
  }, [airtimeFloatsQuery.data]);

  const senderQueueSummary = React.useMemo(
    () =>
      (senderIdsQuery.data ?? []).reduce(
        (summary, row) => {
          if (row.status === "approved") summary.approved += 1;
          else if (row.status === "rejected") summary.rejected += 1;
          else summary.pending += 1;
          return summary;
        },
        { approved: 0, pending: 0, rejected: 0 }
      ),
    [senderIdsQuery.data]
  );

  return (
    <>
      <AppShell
        activePath={selectedMerchantId ? "/app/merchants" : location.pathname}
        mode="live"
        navSections={navSections}
        onModeChange={() => {}}
        shellVariant="admin"
        subtitle="Platform back-office"
        title="RichesPay Admin"
        topBarContent={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="rounded-input border border-slate-700 bg-slate-800 px-4 py-2">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Signed in as</p>
              <p className="text-sm font-medium text-white">
                {sessionData.email ?? "Unknown email"} · {sessionData.role}
              </p>
            </div>
            <Button
              onClick={() => {
                void onSignOutEverywhere();
              }}
              variant="secondary"
            >
              Sign out everywhere
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          {currentPage === "overview" ? (
            <>
              <PageHeader
                subtitle="Platform volume, merchant activity, reconciliation pressure, and channel health at a glance."
                title="Overview"
              />
              {overviewQuery.data && overviewQuery.data.low_float_channels.length > 0 ? (
                <section className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-softer md:flex-row md:items-center md:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-brand">
                      <AlertTriangle className="size-4" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-text">Airtime float is below threshold</p>
                      <p className="text-sm text-text-secondary">
                        {overviewQuery.data.low_float_channels
                          .map((row) => `${row.provider_code} ${row.country_code}${row.network ? ` ${row.network}` : ""}`)
                          .join(", ")}
                      </p>
                    </div>
                  </div>
                  <Link to="/app/airtime">
                    <Button variant="secondary">Review float</Button>
                  </Link>
                </section>
              ) : null}
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Platform volume today" value={overviewQuery.data ? formatMoney(BigInt(overviewQuery.data.platform_volume_today_minor), "GHS", "en-GH") : "-"} />
                <SummaryCard icon={<Users className="size-4" />} label="Active merchants" value={overviewQuery.data?.active_merchants ?? 0} />
                <SummaryCard icon={<FileWarning className="size-4" />} label="Open exceptions" value={overviewQuery.data?.open_exceptions ?? 0} />
                <SummaryCard icon={<Landmark className="size-4" />} label="Channels tracked" value={overviewQuery.data?.channel_health.length ?? 0} />
              </SummaryCardGrid>
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<CreditCard className="size-4" />} label="Airtime volume today" value={overviewQuery.data ? formatMoney(BigInt(overviewQuery.data.airtime_volume_today_minor), "GHS", "en-GH") : "-"} />
                <SummaryCard icon={<AlertTriangle className="size-4" />} label="Low-float channels" value={overviewQuery.data?.low_float_channels.length ?? 0} />
              </SummaryCardGrid>
              <DataTable
                columns={([
                  { accessorKey: "provider_code", header: "Channel" },
                  { accessorKey: "successful_count", header: "Successful" },
                  { accessorKey: "total_count", header: "Total" },
                  { accessorKey: "success_rate", header: "Success rate", cell: ({ row }) => `${(row.original.success_rate * 100).toFixed(1)}%` }
                ] as ColumnDef<OverviewData["success_rate_by_channel"][number]>[]) }
                data={overviewQuery.data?.success_rate_by_channel ?? []}
                emptyState={<EmptyState description="Channel performance appears here once traffic flows through the platform." title="No channel performance yet" />}
                loading={overviewQuery.isLoading}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
              />
              <DataTable
                columns={([
                  { accessorKey: "provider_code", header: "Provider" },
                  { accessorKey: "country_code", header: "Country" },
                  { accessorKey: "kind", header: "Kind" },
                  { accessorKey: "health", header: "Health", cell: ({ row }) => <StatusBadge status={(row.original.health === "healthy" ? "approved" : row.original.health === "degraded" ? "pending" : "rejected") as never} /> },
                  { accessorKey: "status", header: "Status" }
                ] as ColumnDef<OverviewData["channel_health"][number]>[]) }
                data={overviewQuery.data?.channel_health ?? []}
                emptyState={<EmptyState description="Channel health will appear here after providers are configured." title="No channels yet" />}
                loading={overviewQuery.isLoading}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
              />
            </>
          ) : null}

          {currentPage === "merchants" ? (
            <>
              <PageHeader
                subtitle="Search merchants, review platform status, and drill into balances, traffic, KYB, pricing, team membership, and audit history."
                title="Merchants"
              />
              <FilterBar
                filters={[
                  <Input key="merchant-country" label="Country" onChange={(event) => setMerchantCountryFilter(event.target.value)} value={merchantCountryFilter} />,
                  <Select key="merchant-status" label="Status" onValueChange={setMerchantStatusFilter} options={[
                    { label: "All status", value: "" },
                    { label: "Active", value: "active" },
                    { label: "Pending KYB", value: "pending_kyb" },
                    { label: "Suspended", value: "suspended" },
                    { label: "Closed", value: "closed" }
                  ]} value={merchantStatusFilter} />,
                  <Select key="merchant-mode" label="Mode" onValueChange={setGlobalModeFilter} options={[
                    { label: "All modes", value: "" },
                    { label: "Live", value: "live" },
                    { label: "Test", value: "test" }
                  ]} value={globalModeFilter} />
                ]}
                onReset={() => {
                  setMerchantCountryFilter("");
                  setMerchantSearch("");
                  setMerchantStatusFilter("");
                  setGlobalModeFilter("");
                }}
                onSearchChange={setMerchantSearch}
                placeholder="Search merchant name or id"
                searchValue={merchantSearch}
              />
              <div className="flex justify-end">
                <Button
                  leadingIcon={<Download className="size-4" />}
                  onClick={() =>
                    exportCsv(
                      "merchants.csv",
                      ["id", "name", "country", "status", "mode", "today_volume_minor"],
                      (merchantsQuery.data ?? []).map((row) => [
                        row.id,
                        row.name,
                        row.country_code,
                        row.status,
                        row.mode,
                        row.today_volume_minor
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
                  { accessorKey: "name", header: "Merchant" },
                  { accessorKey: "country_code", header: "Country" },
                  { accessorKey: "status", header: "Status" },
                  { accessorKey: "mode", header: "Mode" },
                  { accessorKey: "today_volume_minor", header: "Volume", cell: ({ row }) => formatMoney(BigInt(row.original.today_volume_minor), row.original.settlement_currency as never, "en-GH") },
                  { accessorKey: "freeze", header: "Freeze", cell: ({ row }) => `${row.original.collections_frozen ? "Collections" : ""}${row.original.collections_frozen && row.original.payouts_frozen ? " / " : ""}${row.original.payouts_frozen ? "Payouts" : ""}` || "Clear" }
                ] as ColumnDef<MerchantListRow>[]) }
                data={merchantsQuery.data ?? []}
                emptyState={<EmptyState description="Merchants will appear here once onboarding begins." title="No merchants found" />}
                loading={merchantsQuery.isLoading}
                onRowClick={(row) => navigate(`/app/merchants/${row.id}`)}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
              />
            </>
          ) : null}

          {currentPage === "merchant-detail" ? (
            <>
              <div className="flex items-center gap-3">
                <Link to="/app/merchants">
                  <Button leadingIcon={<ArrowLeft className="size-4" />} variant="secondary">
                    Back to merchants
                  </Button>
                </Link>
                <Select
                  label="Mode"
                  onValueChange={(value) => setMerchantMode(value as Mode)}
                  options={[
                    { label: "Live", value: "live" },
                    { label: "Test", value: "test" }
                  ]}
                  value={merchantMode}
                />
              </div>
              <PageHeader
                subtitle="Review merchant profile, KYB, product traffic, pricing, limits, team membership, freeze controls, and audit evidence."
                title={merchantDetailQuery.data?.trading_name ?? merchantDetailQuery.data?.legal_name ?? selectedMerchantId ?? "Merchant"}
              />
              <div className="flex flex-wrap gap-3">
                <ConfirmDialog
                  confirmLabel={merchantComplianceQuery.data?.collections_frozen ? "Unfreeze collections" : "Freeze collections"}
                  description="Collections controls require a reason and a fresh 2FA confirmation."
                  onConfirm={async (reason) => {
                    if (!selectedMerchantId || !reason) return;
                    await runSensitiveAction({
                      code: freezeCode,
                      task: async () => {
                        await apiRequest(`/admin/v1/merchants/${selectedMerchantId}/${merchantComplianceQuery.data?.collections_frozen ? "collections/unfreeze" : "collections/freeze"}`, {
                          accessToken,
                          body: JSON.stringify({
                            category: freezeCategory,
                            mode: merchantMode,
                            reason
                          }),
                          method: "POST"
                        });
                        setFreezeCode("");
                        await refreshMerchantDetail();
                      }
                    });
                  }}
                  reasonLabel="Reason"
                  requireReason
                  title={merchantComplianceQuery.data?.collections_frozen ? "Unfreeze collections" : "Freeze collections"}
                  trigger={<Button variant="secondary">{merchantComplianceQuery.data?.collections_frozen ? "Unfreeze collections" : "Freeze collections"}</Button>}
                >
                  <Select label="Category" onValueChange={setFreezeCategory} options={[
                    { label: "Operations", value: "operations" },
                    { label: "Fraud review", value: "fraud_review" },
                    { label: "KYB review", value: "kyb_review" },
                    { label: "Regulatory", value: "regulatory" }
                  ]} value={freezeCategory} />
                  <Input label="2FA code" onChange={(event) => setFreezeCode(event.target.value)} value={freezeCode} />
                </ConfirmDialog>
                <ConfirmDialog
                  confirmLabel={merchantComplianceQuery.data?.payouts_frozen ? "Unfreeze payouts" : "Freeze payouts"}
                  description="Payout controls require a reason and a fresh 2FA confirmation."
                  onConfirm={async (reason) => {
                    if (!selectedMerchantId || !reason) return;
                    await runSensitiveAction({
                      code: freezeCode,
                      task: async () => {
                        await apiRequest(`/admin/v1/merchants/${selectedMerchantId}/${merchantComplianceQuery.data?.payouts_frozen ? "payouts/unfreeze" : "payouts/freeze"}`, {
                          accessToken,
                          body: JSON.stringify({
                            category: freezeCategory,
                            mode: merchantMode,
                            reason
                          }),
                          method: "POST"
                        });
                        setFreezeCode("");
                        await refreshMerchantDetail();
                      }
                    });
                  }}
                  reasonLabel="Reason"
                  requireReason
                  title={merchantComplianceQuery.data?.payouts_frozen ? "Unfreeze payouts" : "Freeze payouts"}
                  trigger={<Button variant="secondary">{merchantComplianceQuery.data?.payouts_frozen ? "Unfreeze payouts" : "Freeze payouts"}</Button>}
                >
                  <Select label="Category" onValueChange={setFreezeCategory} options={[
                    { label: "Operations", value: "operations" },
                    { label: "Fraud review", value: "fraud_review" },
                    { label: "KYB review", value: "kyb_review" },
                    { label: "Regulatory", value: "regulatory" }
                  ]} value={freezeCategory} />
                  <Input label="2FA code" onChange={(event) => setFreezeCode(event.target.value)} value={freezeCode} />
                </ConfirmDialog>
                <ConfirmDialog
                  confirmLabel={merchantComplianceQuery.data?.status === "suspended" ? "Reactivate merchant" : "Suspend merchant"}
                  description="Merchant suspension requires a reason and a fresh 2FA confirmation."
                  onConfirm={async (reason) => {
                    if (!selectedMerchantId || !reason) return;
                    await runSensitiveAction({
                      code: freezeCode,
                      task: async () => {
                        await apiRequest(`/admin/v1/merchants/${selectedMerchantId}/${merchantComplianceQuery.data?.status === "suspended" ? "reactivate" : "suspend"}`, {
                          accessToken,
                          body: JSON.stringify({
                            category: freezeCategory,
                            mode: merchantMode,
                            reason
                          }),
                          method: "POST"
                        });
                        setFreezeCode("");
                        await refreshMerchantDetail();
                      }
                    });
                  }}
                  reasonLabel="Reason"
                  requireReason
                  title={merchantComplianceQuery.data?.status === "suspended" ? "Reactivate merchant" : "Suspend merchant"}
                  trigger={<Button variant="danger">{merchantComplianceQuery.data?.status === "suspended" ? "Reactivate merchant" : "Suspend merchant"}</Button>}
                >
                  <Select label="Category" onValueChange={setFreezeCategory} options={[
                    { label: "Operations", value: "operations" },
                    { label: "Fraud review", value: "fraud_review" },
                    { label: "KYB review", value: "kyb_review" },
                    { label: "Regulatory", value: "regulatory" }
                  ]} value={freezeCategory} />
                  <Input label="2FA code" onChange={(event) => setFreezeCode(event.target.value)} value={freezeCode} />
                </ConfirmDialog>
              </div>
              <Tabs
                items={[
                  {
                    label: "Profile",
                    value: "profile",
                    content: (
                      <>
                        <SummaryCardGrid columns={4}>
                          <SummaryCard icon={<Building2 className="size-4" />} label="Status" value={merchantDetailQuery.data?.status ?? "-"} />
                          <SummaryCard icon={<ShieldCheck className="size-4" />} label="KYB tier" value={merchantComplianceQuery.data?.kyb_tier ?? "-"} />
                          <SummaryCard icon={<CreditCard className="size-4" />} label="Collections" value={merchantDetailQuery.data?.products.collections_enabled ? "Enabled" : "Disabled"} />
                          <SummaryCard icon={<Landmark className="size-4" />} label="Payouts" value={merchantDetailQuery.data?.products.payouts_enabled ? "Enabled" : "Disabled"} />
                        </SummaryCardGrid>
                        <SummaryCardGrid columns={4}>
                          <SummaryCard icon={<Send className="size-4" />} label="SMS" value={merchantDetailQuery.data?.products.sms_enabled ? "Enabled" : "Disabled"} />
                          <SummaryCard icon={<CreditCard className="size-4" />} label="Airtime" value={merchantDetailQuery.data?.products.airtime_enabled ? "Enabled" : merchantDetailQuery.data?.products.airtime_requested ? "Requested" : "Disabled"} />
                        </SummaryCardGrid>
                        {merchantDetailQuery.data ? (
                          <MerchantFeatureForm
                            accessToken={accessToken}
                            detail={merchantDetailQuery.data}
                            onSaved={() => void refreshMerchantDetail()}
                          />
                        ) : null}
                      </>
                    )
                  },
                  {
                    label: "KYB",
                    value: "kyb",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "document_type", header: "Document" },
                          { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.status === "approved" ? "approved" : row.original.status === "rejected" ? "rejected" : "pending") as never} /> },
                          { accessorKey: "file_path", header: "File" },
                          { accessorKey: "updated_at", header: "Updated", cell: ({ row }) => formatDateTime(row.original.updated_at) }
                        ] as ColumnDef<MerchantKybData["documents"][number]>[]) }
                        data={merchantKybQuery.data?.documents ?? []}
                        emptyState={<EmptyState description="This merchant has not uploaded KYB documents yet." title="No KYB documents" />}
                        loading={merchantKybQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Balances",
                    value: "balances",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "type", header: "Account" },
                          { accessorKey: "currency", header: "Currency" },
                          { accessorKey: "balance_minor", header: "Balance", cell: ({ row }) => formatMoney(BigInt(row.original.balance_minor), row.original.currency as never, "en-GH") },
                          { accessorKey: "channel_id", header: "Channel" }
                        ] as ColumnDef<MerchantBalanceRow>[]) }
                        data={merchantBalancesQuery.data ?? []}
                        emptyState={<EmptyState description="Ledger balances will appear here once this merchant starts transacting." title="No balances yet" />}
                        loading={merchantBalancesQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Collections",
                    value: "collections",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                          { accessorKey: "id", header: "ID" },
                          { accessorKey: "reference", header: "Reference" },
                          { accessorKey: "amount", header: "Amount", cell: ({ row }) => formatMoney(BigInt(row.original.amount), row.original.currency as never, "en-GH") },
                          { accessorKey: "status", header: "Status" }
                        ] as ColumnDef<MerchantCollectionRow>[]) }
                        data={merchantCollectionsQuery.data ?? []}
                        emptyState={<EmptyState description="Collections will appear once this merchant starts taking payments." title="No collections yet" />}
                        loading={merchantCollectionsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Payouts",
                    value: "payouts",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                          { accessorKey: "id", header: "ID" },
                          { accessorKey: "reference", header: "Reference" },
                          { accessorKey: "amount", header: "Amount", cell: ({ row }) => formatMoney(BigInt(row.original.amount), row.original.currency as never, "en-GH") },
                          { accessorKey: "status", header: "Status" }
                        ] as ColumnDef<MerchantPayoutRow>[]) }
                        data={merchantPayoutsQuery.data ?? []}
                        emptyState={<EmptyState description="Payouts will appear here once this merchant starts disbursing funds." title="No payouts yet" />}
                        loading={merchantPayoutsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "SMS",
                    value: "sms",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                          { accessorKey: "id", header: "Message" },
                          { accessorKey: "recipient", header: "Recipient" },
                          { accessorKey: "price_minor", header: "Cost", cell: ({ row }) => formatAdminMoney(row.original.price_minor, merchantDetailQuery.data?.settlement_currency) },
                          { accessorKey: "status", header: "Status" }
                        ] as ColumnDef<MerchantSmsRow>[]) }
                        data={merchantSmsQuery.data ?? []}
                        emptyState={<EmptyState description="SMS traffic will appear here when this merchant starts sending." title="No messages yet" />}
                        loading={merchantSmsQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Airtime",
                    value: "airtime",
                    content: (
                      <div className="space-y-4">
                        <SummaryCardGrid columns={4}>
                          <SummaryCard icon={<CreditCard className="size-4" />} label="Spend today" value={formatAdminMoney(merchantAirtimeQuery.data?.spend.today_charge_minor, merchantDetailQuery.data?.settlement_currency)} />
                          <SummaryCard icon={<Send className="size-4" />} label="Orders today" value={merchantAirtimeQuery.data?.spend.today_count ?? 0} />
                          <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Merchant daily cap" value={formatAdminMoney(merchantAirtimeLimitsQuery.data?.merchant_daily_cap_minor, merchantDetailQuery.data?.settlement_currency)} />
                          <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Number daily cap" value={formatAdminMoney(merchantAirtimeLimitsQuery.data?.number_daily_cap_minor, merchantDetailQuery.data?.settlement_currency)} />
                        </SummaryCardGrid>
                        {selectedMerchantId && merchantAirtimeLimitsQuery.data ? (
                          <MerchantAirtimeLimitsForm
                            accessToken={accessToken}
                            limits={merchantAirtimeLimitsQuery.data}
                            merchantId={selectedMerchantId}
                            onSaved={() => void refreshMerchantDetail()}
                          />
                        ) : null}
                        <DataTable
                          columns={([
                            { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                            { accessorKey: "id", header: "ID" },
                            { accessorKey: "phone", header: "Phone" },
                            { accessorKey: "charge_amount", header: "Charge", cell: ({ row }) => formatMoney(BigInt(row.original.charge_amount), row.original.charge_currency as never, "en-GH") },
                            { accessorKey: "status", header: "Status" }
                          ] as ColumnDef<AirtimeOrderAdminRow>[]) }
                          data={merchantAirtimeQuery.data?.orders ?? []}
                          emptyState={<EmptyState description="Airtime orders will appear here when this merchant starts sending top-ups." title="No airtime orders yet" />}
                          loading={merchantAirtimeQuery.isLoading}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                        />
                      </div>
                    )
                  },
                  {
                    label: "Pricing",
                    value: "pricing",
                    content: (
                      <Tabs
                        items={[
                          {
                            label: "Defaults",
                            value: "defaults",
                            content: (
                              <DataTable
                                columns={([
                                  { accessorKey: "name", header: "Plan" },
                                  { accessorKey: "kind", header: "Kind" },
                                  { accessorKey: "method", header: "Method" },
                                  { accessorKey: "percent_bps", header: "Percent (bps)" },
                                  { accessorKey: "fixed_minor", header: "Fixed", cell: ({ row }) => formatMoney(BigInt(row.original.fixed_minor), row.original.currency as never, "en-GH") }
                                ] as ColumnDef<FeePlanRow>[]) }
                                data={merchantPricingQuery.data?.default_fee_plans ?? []}
                                emptyState={<EmptyState description="Default pricing plans for this merchant country will appear here." title="No default fee plans" />}
                                loading={merchantPricingQuery.isLoading}
                                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                              />
                            )
                          },
                          {
                            label: "Overrides",
                            value: "overrides",
                            content: (
                              <DataTable
                                columns={([
                                  { accessorKey: "name", header: "Override" },
                                  { accessorKey: "kind", header: "Kind" },
                                  { accessorKey: "method", header: "Method" },
                                  { accessorKey: "percent_bps", header: "Percent (bps)" },
                                  { accessorKey: "fixed_minor", header: "Fixed", cell: ({ row }) => formatMoney(BigInt(row.original.fixed_minor), row.original.currency as never, "en-GH") }
                                ] as ColumnDef<MerchantOverrideRow>[]) }
                                data={merchantPricingQuery.data?.merchant_overrides ?? []}
                                emptyState={<EmptyState description="Merchant pricing overrides will appear here if negotiated." title="No overrides" />}
                                loading={merchantPricingQuery.isLoading}
                                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                              />
                            )
                          }
                        ]}
                      />
                    )
                  },
                  {
                    label: "Limits",
                    value: "limits",
                    content: (
                      <SummaryCardGrid columns={4}>
                        <SummaryCard icon={<CreditCard className="size-4" />} label="Collection min" value={merchantComplianceQuery.data ? formatMoney(BigInt(merchantComplianceQuery.data.limits.collection.min_minor), merchantComplianceQuery.data.settlement_currency, "en-GH") : "-"} />
                        <SummaryCard icon={<CreditCard className="size-4" />} label="Collection max" value={merchantComplianceQuery.data ? formatMoney(BigInt(merchantComplianceQuery.data.limits.collection.max_minor), merchantComplianceQuery.data.settlement_currency, "en-GH") : "-"} />
                        <SummaryCard icon={<Landmark className="size-4" />} label="Payout min" value={merchantComplianceQuery.data ? formatMoney(BigInt(merchantComplianceQuery.data.limits.payout.min_minor), merchantComplianceQuery.data.settlement_currency, "en-GH") : "-"} />
                        <SummaryCard icon={<Landmark className="size-4" />} label="Payout max" value={merchantComplianceQuery.data ? formatMoney(BigInt(merchantComplianceQuery.data.limits.payout.max_minor), merchantComplianceQuery.data.settlement_currency, "en-GH") : "-"} />
                      </SummaryCardGrid>
                    )
                  },
                  {
                    label: "Team",
                    value: "team",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "full_name", header: "Name" },
                          { accessorKey: "email", header: "Email" },
                          { accessorKey: "role", header: "Role" },
                          { accessorKey: "user_id", header: "User ID" }
                        ] as ColumnDef<MerchantTeamRow>[]) }
                        data={merchantTeamQuery.data ?? []}
                        emptyState={<EmptyState description="Merchant team memberships will appear here." title="No team members yet" />}
                        loading={merchantTeamQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Freeze history",
                    value: "freeze-history",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                          { accessorKey: "freeze_type", header: "Type" },
                          { accessorKey: "action", header: "Action" },
                          { accessorKey: "reason", header: "Reason" }
                        ] as ColumnDef<MerchantFreezeHistoryRow>[]) }
                        data={merchantFreezeHistoryQuery.data ?? []}
                        emptyState={<EmptyState description="Freeze and unfreeze activity will appear here." title="No freeze history yet" />}
                        loading={merchantFreezeHistoryQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Audit",
                    value: "audit",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                          { accessorKey: "action", header: "Action" },
                          { accessorKey: "actor_id", header: "Actor" },
                          { accessorKey: "reason", header: "Reason" }
                        ] as ColumnDef<AuditLogRow>[]) }
                        data={merchantAuditQuery.data ?? []}
                        emptyState={<EmptyState description="Merchant audit evidence will appear here after platform actions occur." title="No audit activity yet" />}
                        loading={merchantAuditQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  }
                ]}
              />
            </>
          ) : null}

          {currentPage === "kyb" ? (
            <>
              <PageHeader subtitle="Review merchants waiting on KYB approval, rejection, or more information requests." title="KYB Review Queue" />
              <DataTable
                columns={([
                  { accessorKey: "merchant_name", header: "Merchant" },
                  { accessorKey: "mode", header: "Mode" },
                  { accessorKey: "pending_document_count", header: "Pending docs" },
                  { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.status === "approved" ? "approved" : row.original.status === "rejected" ? "rejected" : "pending") as never} /> },
                  { accessorKey: "updated_at", header: "Updated", cell: ({ row }) => formatDateTime(row.original.updated_at) }
                ] as ColumnDef<KybQueueRow>[]) }
                data={kybQueueQuery.data ?? []}
                emptyState={<EmptyState description="Merchants with pending KYB will appear here." title="No KYB reviews pending" />}
                loading={kybQueueQuery.isLoading}
                onRowClick={(row) => {
                  setKybReviewTarget(row);
                  setKybReviewNote(row.review_note ?? "");
                  setKybReviewStatus(row.status);
                }}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
              />
            </>
          ) : null}

          {currentPage === "compliance-flags" ? (
            <>
              <PageHeader subtitle="Investigate velocity and compliance review flags raised by platform controls, including airtime number velocity from A1." title="Compliance Flags" />
              <FilterBar
                filters={[
                  <Select
                    key="flag-rule"
                    label="Rule"
                    onValueChange={setFlagRuleFilter}
                    options={[
                      { label: "All rules", value: "" },
                      { label: "Airtime velocity", value: "airtime.number_velocity" },
                      { label: "Collection velocity", value: "collections.phone_velocity" }
                    ]}
                    value={flagRuleFilter}
                  />
                ]}
                onReset={() => {
                  setFlagRuleFilter("");
                  setFlagSearch("");
                }}
                onSearchChange={setFlagSearch}
                placeholder="Search rule, merchant, or summary"
                searchValue={flagSearch}
              />
              <DataTable
                columns={([
                  { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at) },
                  { accessorKey: "rule_code", header: "Rule", cell: ({ row }) => (row.original.rule_code === "airtime.number_velocity" ? "Airtime velocity" : row.original.rule_code) },
                  { accessorKey: "merchant_id", header: "Merchant" },
                  { accessorKey: "summary", header: "Summary" },
                  { accessorKey: "status", header: "Status" }
                ] as ColumnDef<ComplianceFlagRow>[]) }
                data={filteredFlags}
                emptyState={<EmptyState description="Open review flags will appear here when the platform detects risky activity." title="No open flags" />}
                loading={flagsQuery.isLoading}
                onRowClick={(row) => setSelectedFlag(row)}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
              />
            </>
          ) : null}

          {currentPage === "channels" ? (
            <>
              <PageHeader subtitle="Track provider health, review routing rules, and switch primary routes with reasoned and 2FA-confirmed changes." title="Channels & Routing" />
              <Tabs
                items={[
                  {
                    label: "Channels",
                    value: "channels",
                    content: (
                      <div className="space-y-4">
                        <Select
                          label="Kind"
                          onValueChange={setChannelKindFilter}
                          options={[
                            { label: "All kinds", value: "" },
                            { label: "Mobile money", value: "mobile_money" },
                            { label: "Airtime", value: "airtime" },
                            { label: "SMS", value: "sms" },
                            { label: "Card", value: "card" },
                            { label: "Bank", value: "bank" }
                          ]}
                          value={channelKindFilter}
                        />
                        <DataTable
                          columns={([
                            { accessorKey: "provider_code", header: "Provider" },
                            { accessorKey: "country_code", header: "Country" },
                            { accessorKey: "kind", header: "Kind" },
                            { accessorKey: "health", header: "Health", cell: ({ row }) => <StatusBadge status={(row.original.health === "healthy" ? "approved" : row.original.health === "degraded" ? "pending" : "rejected") as never} /> },
                            { accessorKey: "status", header: "Status" }
                          ] as ColumnDef<ChannelRow>[]) }
                          data={filteredChannels}
                          emptyState={<EmptyState description="Configured provider channels will appear here." title="No channels configured" />}
                          loading={channelsQuery.isLoading}
                          onRowClick={(row) => setSelectedChannel(row)}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                        />
                      </div>
                    )
                  },
                  {
                    label: "Routing",
                    value: "routing",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "country_code", header: "Country" },
                          { accessorKey: "kind", header: "Kind" },
                          { accessorKey: "capability", header: "Capability" },
                          { accessorKey: "network", header: "Network" },
                          { accessorKey: "channel_ids", header: "Priority", cell: ({ row }) => row.original.channel_ids.join(" -> ") }
                        ] as ColumnDef<RoutingRuleRow>[]) }
                        data={routingRulesQuery.data ?? []}
                        emptyState={<EmptyState description="Routing rules appear here once platform routing is configured." title="No routing rules" />}
                        loading={routingRulesQuery.isLoading}
                        onRowClick={(row) => {
                          setSelectedRule(row);
                        }}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  }
                ]}
              />
            </>
          ) : null}

          {currentPage === "transactions" ? (
            <>
              <PageHeader subtitle="Search globally by RichesPay id, merchant reference, phone number, or provider reference." title="Transactions" />
              <FilterBar
                filters={[
                  <Select key="transaction-mode" label="Mode" onValueChange={setGlobalModeFilter} options={[
                    { label: "All modes", value: "" },
                    { label: "Live", value: "live" },
                    { label: "Test", value: "test" }
                  ]} value={globalModeFilter} />
                ]}
                onReset={() => {
                  setGlobalModeFilter("");
                  setTransactionSearch("");
                }}
                onSearchChange={setTransactionSearch}
                placeholder="Search id, reference, phone, or provider ref"
                searchValue={transactionSearch}
              />
              <DataTable
                columns={([
                  { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                  { accessorKey: "resource_type", header: "Type" },
                  { accessorKey: "id", header: "RichesPay ID" },
                  { accessorKey: "merchant_id", header: "Merchant" },
                  { accessorKey: "reference", header: "Reference" },
                  { accessorKey: "provider_ref", header: "Provider ref" },
                  { accessorKey: "status", header: "Status" }
                ] as ColumnDef<TransactionSearchRow>[]) }
                data={transactionSearchQuery.data ?? []}
                emptyState={<EmptyState description="Run a search to find collections, payouts, or SMS across the platform." title="No transactions loaded" />}
                loading={transactionSearchQuery.isLoading}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 30 }}
              />
            </>
          ) : null}

          {currentPage === "reconciliation" ? (
            <>
              <PageHeader subtitle="Watch daily summaries and resolve open reconciliation exceptions with clear reasons." title="Reconciliation" />
              <Tabs
                items={[
                  {
                    label: "Summaries",
                    value: "summaries",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "statement_date", header: "Statement date" },
                          { accessorKey: "channel_id", header: "Channel" },
                          { accessorKey: "collection_volume", header: "Collections", cell: ({ row }) => formatMoney(BigInt(row.original.collection_volume), row.original.currency as never, "en-GH") },
                          { accessorKey: "payout_volume", header: "Payouts", cell: ({ row }) => formatMoney(BigInt(row.original.payout_volume), row.original.currency as never, "en-GH") },
                          { accessorKey: "balances_match", header: "Balanced", cell: ({ row }) => row.original.balances_match ? "Yes" : "No" }
                        ] as ColumnDef<ReconSummaryRow>[]) }
                        data={reconciliationSummariesQuery.data ?? []}
                        emptyState={<EmptyState description="Daily reconciliation summaries will appear here after statement imports or fetches." title="No summaries yet" />}
                        loading={reconciliationSummariesQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 20 }}
                      />
                    )
                  },
                  {
                    label: "Exceptions",
                    value: "exceptions",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "created_at", header: "Created", cell: ({ row }) => formatDateTime(row.original.created_at) },
                          { accessorKey: "exception_type", header: "Type" },
                          { accessorKey: "merchant_id", header: "Merchant" },
                          { accessorKey: "provider_ref", header: "Provider ref" },
                          { accessorKey: "status", header: "Status" }
                        ] as ColumnDef<ReconExceptionRow>[]) }
                        data={reconciliationExceptionsQuery.data ?? []}
                        emptyState={<EmptyState description="Open reconciliation exceptions will appear here." title="No open exceptions" />}
                        loading={reconciliationExceptionsQuery.isLoading}
                        onRowClick={(row) => setSelectedException(row)}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  }
                ]}
              />
            </>
          ) : null}

          {currentPage === "sender-ids" ? (
            <>
              <PageHeader subtitle="Review sender ID submissions, export operator sheets, and manage the platform OTP fallback sender." title="Sender ID Queue" />
              <SummaryCardGrid columns={3}>
                <SummaryCard icon={<ShieldCheck className="size-4" />} label="Approved" value={senderQueueSummary.approved} />
                <SummaryCard icon={<AlertTriangle className="size-4" />} label="Pending" value={senderQueueSummary.pending} />
                <SummaryCard icon={<FileWarning className="size-4" />} label="Rejected" value={senderQueueSummary.rejected} />
              </SummaryCardGrid>
              <FilterBar
                filters={[
                  <Input key="sender-country" label="Country" onChange={(event) => setSenderIdCountryFilter(event.target.value)} value={senderIdCountryFilter} />,
                  <Input key="sender-network" label="Network" onChange={(event) => setSenderIdNetworkFilter(event.target.value)} value={senderIdNetworkFilter} />,
                  <Select key="sender-status" label="Status" onValueChange={setSenderIdStatusFilter} options={[
                    { label: "All status", value: "" },
                    { label: "Pending", value: "pending" },
                    { label: "Submitted", value: "submitted" },
                    { label: "Approved", value: "approved" },
                    { label: "Rejected", value: "rejected" }
                  ]} value={senderIdStatusFilter} />
                ]}
                onReset={() => {
                  setSenderIdCountryFilter("");
                  setSenderIdNetworkFilter("");
                  setSenderIdStatusFilter("");
                }}
              />
              <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
                <DataTable
                  columns={([
                    { accessorKey: "merchant_name", header: "Merchant" },
                    { accessorKey: "sender_id", header: "Sender ID" },
                    { accessorKey: "country_code", header: "Country" },
                    { accessorKey: "network", header: "Network" },
                    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={(row.original.status === "approved" ? "approved" : row.original.status === "rejected" ? "rejected" : "pending") as never} /> }
                  ] as ColumnDef<SenderIdQueueRow>[]) }
                  data={senderIdsQuery.data ?? []}
                  emptyState={<EmptyState description="Sender ID requests will appear here after merchants start applying." title="No sender ID requests" />}
                  loading={senderIdsQuery.isLoading}
                  onRowClick={(row) => setSelectedSenderIdRow(row)}
                  pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 200 }}
                />
                <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
                  <div className="space-y-4">
                    <Select
                      label="Mode"
                      onValueChange={(value) => setSettingsMode(value as Mode)}
                      options={[
                        { label: "Live", value: "live" },
                        { label: "Test", value: "test" }
                      ]}
                      value={settingsMode}
                    />
                    <Input label="Default OTP sender ID" onChange={(event) => setDefaultOtpSenderId(event.target.value.toUpperCase())} value={defaultOtpSenderId} />
                    <Button
                      onClick={async () => {
                        try {
                          await apiRequest(`/admin/v1/sms/platform-settings/${settingsMode}`, {
                            accessToken,
                            body: JSON.stringify({
                              default_otp_sender_id: defaultOtpSenderId.trim() === "" ? null : defaultOtpSenderId
                            }),
                            method: "PUT"
                          });
                          pushToast({
                            description: "The platform OTP fallback sender ID has been updated.",
                            title: "Settings saved",
                            variant: "success"
                          });
                          await queryClient.invalidateQueries({ queryKey: ["admin-platform-sms-settings"] });
                        } catch (error) {
                          pushToast({
                            description: error instanceof ApiError ? error.message : "Unable to save platform SMS settings.",
                            title: "Save failed",
                            variant: "danger"
                          });
                        }
                      }}
                      variant="primary"
                    >
                      Save fallback sender ID
                    </Button>
                  </div>
                </section>
              </div>
            </>
          ) : null}

          {currentPage === "airtime" ? (
            <>
              <PageHeader
                subtitle="Networks, merchant discounts, provider float, and global airtime order search."
                title="Airtime"
              />
              <SummaryCardGrid columns={4}>
                <SummaryCard icon={<CreditCard className="size-4" />} label="Networks" value={airtimeNetworksQuery.data?.length ?? 0} />
                <SummaryCard icon={<CircleDollarSign className="size-4" />} label="Default discounts" value={airtimeDiscountPlansQuery.data?.length ?? 0} />
                <SummaryCard icon={<AlertTriangle className="size-4" />} label="Below threshold" value={airtimeFloatSummary.below} />
                <SummaryCard icon={<Search className="size-4" />} label="Orders in view" value={airtimeOrdersQuery.data?.length ?? 0} />
              </SummaryCardGrid>
              <Tabs
                items={[
                  {
                    label: "Networks",
                    value: "networks",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "country_code", header: "Country" },
                          { accessorKey: "network", header: "Network" },
                          { accessorKey: "currency", header: "Currency" },
                          { accessorKey: "min_amount", header: "Min", cell: ({ row }) => formatMoney(BigInt(row.original.min_amount), row.original.currency as never, "en-GH") },
                          { accessorKey: "max_amount", header: "Max", cell: ({ row }) => formatMoney(BigInt(row.original.max_amount), row.original.currency as never, "en-GH") },
                          { accessorKey: "fixed_denominations", header: "Denoms", cell: ({ row }) => (row.original.fixed_denominations?.length ? `${row.original.fixed_denominations.length} fixed` : "Range") },
                          { accessorKey: "active", header: "Active", cell: ({ row }) => (row.original.active ? "Yes" : "No") }
                        ] as ColumnDef<AirtimeNetworkAdminRow>[]) }
                        data={airtimeNetworksQuery.data ?? []}
                        emptyState={<EmptyState description="Seeded launch networks will appear here after the airtime migration." title="No airtime networks" />}
                        loading={airtimeNetworksQuery.isLoading}
                        onRowClick={(row) => {
                          setAirtimeNetworkDraft(row);
                          setAirtimeNetworkMin(String(row.min_amount));
                          setAirtimeNetworkMax(String(row.max_amount));
                          setAirtimeNetworkActive(row.active);
                          setAirtimeNetworkDenoms((row.fixed_denominations ?? []).join(", "));
                        }}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  },
                  {
                    label: "Discount plans",
                    value: "discounts",
                    content: (
                      <Tabs
                        items={[
                          {
                            label: "Defaults",
                            value: "defaults",
                            content: (
                              <div className="space-y-4">
                                <div className="grid gap-3 md:grid-cols-4">
                                  <Input label="Country" onChange={(event) => setAirtimeDiscountCountry(event.target.value.toUpperCase())} value={airtimeDiscountCountry} />
                                  <Input label="Network" onChange={(event) => setAirtimeDiscountNetwork(event.target.value.toUpperCase())} value={airtimeDiscountNetwork} />
                                  <Input label="Discount (bps)" onChange={(event) => setAirtimeDiscountBps(event.target.value)} value={airtimeDiscountBps} />
                                  <Input label="Reason" onChange={(event) => setAirtimeDiscountReason(event.target.value)} value={airtimeDiscountReason} />
                                </div>
                                <Button
                                  loading={airtimeSaving}
                                  onClick={() => {
                                    if (!airtimeDiscountReason.trim() || airtimeSaving) {
                                      return;
                                    }
                                    setAirtimeSaving(true);
                                    void apiRequest("/admin/v1/airtime/discount-plans", {
                                      accessToken,
                                      body: JSON.stringify({
                                        country_code: airtimeDiscountCountry,
                                        discount_bps: Number(airtimeDiscountBps),
                                        merchant_id: null,
                                        mode: null,
                                        network: airtimeDiscountNetwork,
                                        reason: airtimeDiscountReason
                                      }),
                                      method: "PUT"
                                    })
                                      .then(async () => {
                                        pushToast({ description: "The default discount was saved.", title: "Discount updated", variant: "success" });
                                        await queryClient.invalidateQueries({ queryKey: ["admin-airtime-discount-plans"] });
                                      })
                                      .catch((error: unknown) => {
                                        pushToast({
                                          description: error instanceof ApiError ? error.message : "Unable to save the discount plan.",
                                          title: "Update failed",
                                          variant: "danger"
                                        });
                                      })
                                      .finally(() => setAirtimeSaving(false));
                                  }}
                                  variant="primary"
                                >
                                  Save default discount
                                </Button>
                                <DataTable
                                  columns={([
                                    { accessorKey: "country_code", header: "Country" },
                                    { accessorKey: "network", header: "Network" },
                                    { accessorKey: "discount_bps", header: "Discount (bps)" },
                                    { accessorKey: "active", header: "Active", cell: ({ row }) => (row.original.active ? "Yes" : "No") }
                                  ] as ColumnDef<AirtimeDiscountPlanRow>[]) }
                                  data={airtimeDiscountPlansQuery.data ?? []}
                                  emptyState={<EmptyState description="Default discounts are seeded with the airtime migration." title="No discount plans" />}
                                  loading={airtimeDiscountPlansQuery.isLoading}
                                  pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                                />
                              </div>
                            )
                          },
                          {
                            label: "Merchant overrides",
                            value: "overrides",
                            content: (
                              <div className="space-y-4">
                                <div className="grid gap-3 md:grid-cols-3">
                                  <Input label="Merchant ID" onChange={(event) => setAirtimeOverrideMerchantId(event.target.value)} value={airtimeOverrideMerchantId} />
                                  <Select
                                    label="Mode"
                                    onValueChange={(value) => setAirtimeOverrideMode(value as Mode)}
                                    options={[
                                      { label: "Live", value: "live" },
                                      { label: "Test", value: "test" }
                                    ]}
                                    value={airtimeOverrideMode}
                                  />
                                  <Input label="Country" onChange={(event) => setAirtimeOverrideCountry(event.target.value.toUpperCase())} value={airtimeOverrideCountry} />
                                  <Input label="Network" onChange={(event) => setAirtimeOverrideNetwork(event.target.value.toUpperCase())} value={airtimeOverrideNetwork} />
                                  <Input label="Discount (bps)" onChange={(event) => setAirtimeOverrideBps(event.target.value)} value={airtimeOverrideBps} />
                                  <Input label="Reason" onChange={(event) => setAirtimeOverrideReason(event.target.value)} value={airtimeOverrideReason} />
                                </div>
                                <Button
                                  loading={airtimeSaving}
                                  onClick={() => {
                                    if (!airtimeOverrideMerchantId.trim() || !airtimeOverrideReason.trim() || airtimeSaving) {
                                      return;
                                    }
                                    setAirtimeSaving(true);
                                    void apiRequest("/admin/v1/airtime/discount-plans", {
                                      accessToken,
                                      body: JSON.stringify({
                                        country_code: airtimeOverrideCountry,
                                        discount_bps: Number(airtimeOverrideBps),
                                        merchant_id: airtimeOverrideMerchantId.trim(),
                                        mode: airtimeOverrideMode,
                                        network: airtimeOverrideNetwork,
                                        reason: airtimeOverrideReason
                                      }),
                                      method: "PUT"
                                    })
                                      .then(async () => {
                                        pushToast({ description: "The merchant override was saved and audited.", title: "Override updated", variant: "success" });
                                        setAirtimeOverrideReason("");
                                        await queryClient.invalidateQueries({ queryKey: ["admin-airtime-discount-overrides"] });
                                      })
                                      .catch((error: unknown) => {
                                        pushToast({
                                          description: error instanceof ApiError ? error.message : "Unable to save the merchant override.",
                                          title: "Update failed",
                                          variant: "danger"
                                        });
                                      })
                                      .finally(() => setAirtimeSaving(false));
                                  }}
                                  variant="primary"
                                >
                                  Save merchant override
                                </Button>
                                <DataTable
                                  columns={([
                                    { accessorKey: "merchant_id", header: "Merchant" },
                                    { accessorKey: "mode", header: "Mode" },
                                    { accessorKey: "country_code", header: "Country" },
                                    { accessorKey: "network", header: "Network" },
                                    { accessorKey: "discount_bps", header: "Discount (bps)" },
                                    { accessorKey: "active", header: "Active", cell: ({ row }) => (row.original.active ? "Yes" : "No") }
                                  ] as ColumnDef<AirtimeDiscountPlanRow>[]) }
                                  data={airtimeDiscountOverridesQuery.data ?? []}
                                  emptyState={<EmptyState description="Per-merchant discount overrides appear here after a reasoned save." title="No merchant overrides" />}
                                  loading={airtimeDiscountOverridesQuery.isLoading}
                                  pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                                />
                              </div>
                            )
                          }
                        ]}
                      />
                    )
                  },
                  {
                    label: "Float",
                    value: "float",
                    content: (
                      <div className="space-y-4">
                        <SummaryCardGrid columns={4}>
                          <SummaryCard icon={<Landmark className="size-4" />} label="Channels" value={airtimeFloatSummary.total} />
                          <SummaryCard icon={<AlertTriangle className="size-4" />} label="Below threshold" value={airtimeFloatSummary.below} />
                          <SummaryCard icon={<FileWarning className="size-4" />} label="Empty" value={airtimeFloatSummary.empty} />
                          <SummaryCard icon={<Activity className="size-4" />} label="Last check" value={airtimeFloatsQuery.data?.some((row) => row.checked_at) ? "Recorded" : "-"} />
                        </SummaryCardGrid>
                        <DataTable
                          columns={([
                            { accessorKey: "provider_code", header: "Provider" },
                            { accessorKey: "country_code", header: "Country" },
                            { accessorKey: "network", header: "Network" },
                            { accessorKey: "balance_minor", header: "Balance", cell: ({ row }) => (row.original.balance_minor === null ? "-" : formatMoney(BigInt(row.original.balance_minor), (row.original.currency ?? "ZMW") as never, "en-GH")) },
                            { accessorKey: "threshold_minor", header: "Threshold", cell: ({ row }) => (row.original.threshold_minor === null ? "-" : formatMoney(BigInt(row.original.threshold_minor), (row.original.currency ?? "ZMW") as never, "en-GH")) },
                            { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={airtimeFloatBadge(row.original.status)} /> },
                            { accessorKey: "checked_at", header: "Checked", cell: ({ row }) => (row.original.checked_at ? formatDateTime(row.original.checked_at) : "-") }
                          ] as ColumnDef<AirtimeFloatRow>[]) }
                          data={airtimeFloatsQuery.data ?? []}
                          emptyState={<EmptyState description="Float snapshots appear after the 5-minute monitor runs." title="No float readings" />}
                          loading={airtimeFloatsQuery.isLoading}
                          onRowClick={(row) => {
                            setSelectedAirtimeFloat(row);
                            setAirtimeFloatThreshold(row.threshold_minor === null ? "" : String(row.threshold_minor));
                            setAirtimeFloatReason("");
                          }}
                          pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                        />
                      </div>
                    )
                  },
                  {
                    label: "Orders",
                    value: "orders",
                    content: (
                      <div className="space-y-4">
                        <FilterBar
                          filters={[
                            <Select
                              key="airtime-order-mode"
                              label="Mode"
                              onValueChange={setAirtimeOrderMode}
                              options={[
                                { label: "All modes", value: "" },
                                { label: "Live", value: "live" },
                                { label: "Test", value: "test" }
                              ]}
                              value={airtimeOrderMode}
                            />
                          ]}
                          onReset={() => {
                            setAirtimeOrderMode("");
                            setAirtimeOrderSearch("");
                          }}
                          onSearchChange={setAirtimeOrderSearch}
                          placeholder="Search air_ id, phone, reference, or provider ref"
                          searchValue={airtimeOrderSearch}
                        />
                        <DataTable
                          columns={([
                            { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                            { accessorKey: "id", header: "ID" },
                            { accessorKey: "merchant_id", header: "Merchant" },
                            { accessorKey: "phone", header: "Phone" },
                            { accessorKey: "charge_amount", header: "Charge", cell: ({ row }) => formatMoney(BigInt(row.original.charge_amount), row.original.charge_currency as never, "en-GH") },
                            { accessorKey: "status", header: "Status" }
                          ] as ColumnDef<AirtimeOrderAdminRow>[]) }
                          data={airtimeOrdersQuery.data ?? []}
                          emptyState={<EmptyState description="Search by air_ id, phone, merchant reference, or provider reference." title="No airtime orders" />}
                          loading={airtimeOrdersQuery.isLoading}
                          onRowClick={(row) => setSelectedAirtimeOrder(row)}
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
                    setAirtimeNetworkDraft(null);
                  }
                }}
                open={Boolean(airtimeNetworkDraft)}
                title="Edit airtime network"
              >
                {airtimeNetworkDraft ? (
                  <div className="space-y-4">
                    <p className="text-sm text-text-secondary">
                      {airtimeNetworkDraft.network} {airtimeNetworkDraft.country_code}
                    </p>
                    <Checkbox checked={airtimeNetworkActive} label="Active" onChange={() => setAirtimeNetworkActive((current) => !current)} />
                    <Input label="Minimum (minor units)" onChange={(event) => setAirtimeNetworkMin(event.target.value)} value={airtimeNetworkMin} />
                    <Input label="Maximum (minor units)" onChange={(event) => setAirtimeNetworkMax(event.target.value)} value={airtimeNetworkMax} />
                    <Input label="Fixed denominations (minor units, comma-separated)" onChange={(event) => setAirtimeNetworkDenoms(event.target.value)} value={airtimeNetworkDenoms} />
                    <Input label="Reason" onChange={(event) => setAirtimeNetworkReason(event.target.value)} value={airtimeNetworkReason} />
                    <Button
                      loading={airtimeSaving}
                      onClick={() => {
                        if (!airtimeNetworkDraft || !airtimeNetworkReason.trim() || airtimeSaving) {
                          return;
                        }
                        setAirtimeSaving(true);
                        void apiRequest(`/admin/v1/airtime/networks/${airtimeNetworkDraft.country_code}/${airtimeNetworkDraft.network}`, {
                          accessToken,
                          body: JSON.stringify({
                            active: airtimeNetworkActive,
                            currency: airtimeNetworkDraft.currency,
                            fixed_denominations: parseDenominations(airtimeNetworkDenoms),
                            max_amount: Number(airtimeNetworkMax),
                            min_amount: Number(airtimeNetworkMin),
                            reason: airtimeNetworkReason
                          }),
                          method: "PUT"
                        })
                          .then(async () => {
                            pushToast({ description: "The network limits were saved.", title: "Network updated", variant: "success" });
                            setAirtimeNetworkDraft(null);
                            await queryClient.invalidateQueries({ queryKey: ["admin-airtime-networks"] });
                          })
                          .catch((error: unknown) => {
                            pushToast({
                              description: error instanceof ApiError ? error.message : "Unable to update this network.",
                              title: "Update failed",
                              variant: "danger"
                            });
                          })
                          .finally(() => setAirtimeSaving(false));
                      }}
                      variant="primary"
                    >
                      Save network
                    </Button>
                  </div>
                ) : null}
              </Drawer>
              <Drawer
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedAirtimeFloat(null);
                  }
                }}
                open={Boolean(selectedAirtimeFloat)}
                title="Airtime float"
              >
                {selectedAirtimeFloat ? (
                  <div className="space-y-4">
                    <CopyField label="Channel ID" value={selectedAirtimeFloat.channel_id} />
                    <p className="text-sm text-text-secondary">
                      {selectedAirtimeFloat.provider_code} · {selectedAirtimeFloat.country_code}
                      {selectedAirtimeFloat.network ? ` · ${selectedAirtimeFloat.network}` : ""}
                    </p>
                    <StatusBadge status={airtimeFloatBadge(selectedAirtimeFloat.status)} />
                    <AirtimeFloatHistoryChart
                      currency={selectedAirtimeFloat.currency ?? "ZMW"}
                      points={airtimeFloatHistoryQuery.data ?? []}
                    />
                    <Input label="Low-float threshold (minor units)" onChange={(event) => setAirtimeFloatThreshold(event.target.value)} value={airtimeFloatThreshold} />
                    <Input label="Reason" onChange={(event) => setAirtimeFloatReason(event.target.value)} value={airtimeFloatReason} />
                    <Button
                      loading={airtimeSaving}
                      onClick={() => {
                        if (!selectedAirtimeFloat || !airtimeFloatReason.trim() || airtimeSaving) {
                          return;
                        }
                        setAirtimeSaving(true);
                        void apiRequest(`/admin/v1/airtime/floats/${selectedAirtimeFloat.channel_id}`, {
                          accessToken,
                          body: JSON.stringify({
                            reason: airtimeFloatReason,
                            threshold_minor: Number(airtimeFloatThreshold)
                          }),
                          method: "PUT"
                        })
                          .then(async () => {
                            pushToast({ description: "The float threshold was saved.", title: "Threshold updated", variant: "success" });
                            setSelectedAirtimeFloat(null);
                            await queryClient.invalidateQueries({ queryKey: ["admin-airtime-floats"] });
                          })
                          .catch((error: unknown) => {
                            pushToast({
                              description: error instanceof ApiError ? error.message : "Unable to update this threshold.",
                              title: "Update failed",
                              variant: "danger"
                            });
                          })
                          .finally(() => setAirtimeSaving(false));
                      }}
                      variant="primary"
                    >
                      Save threshold
                    </Button>
                  </div>
                ) : null}
              </Drawer>
              <Drawer onOpenChange={(open) => !open && setSelectedAirtimeOrder(null)} open={Boolean(selectedAirtimeOrder)} title="Airtime order">
                {selectedAirtimeOrder ? (
                  <div className="space-y-4">
                    <CopyField label="Order ID" value={selectedAirtimeOrder.id} />
                    <CopyField label="Merchant" value={selectedAirtimeOrder.merchant_id} />
                    <CopyField label="Phone" value={selectedAirtimeOrder.phone} />
                    <CopyField label="Reference" value={selectedAirtimeOrder.reference ?? "-"} />
                    <CopyField label="Provider ref" value={selectedAirtimeOrder.provider_ref ?? "-"} />
                    <p className="text-sm text-text-secondary">
                      {formatMoney(BigInt(selectedAirtimeOrder.amount), selectedAirtimeOrder.currency as never, "en-GH")} face value · charged {formatMoney(BigInt(selectedAirtimeOrder.charge_amount), selectedAirtimeOrder.charge_currency as never, "en-GH")}
                    </p>
                  </div>
                ) : null}
              </Drawer>
            </>
          ) : null}

          {currentPage === "pricing" ? (
            <>
              <PageHeader
                action={<Button onClick={() => setFxModalOpen(true)} variant="primary">Add FX rate</Button>}
                subtitle="Review platform default fee plans, merchant overrides, and active FX rates."
                title="Pricing & FX"
              />
              <Tabs
                items={[
                  {
                    label: "Fee plans",
                    value: "fee-plans",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "name", header: "Plan" },
                          { accessorKey: "country_code", header: "Country" },
                          { accessorKey: "kind", header: "Kind" },
                          { accessorKey: "method", header: "Method" },
                          { accessorKey: "percent_bps", header: "Percent (bps)" },
                          { accessorKey: "fixed_minor", header: "Fixed", cell: ({ row }) => formatMoney(BigInt(row.original.fixed_minor), row.original.currency as never, "en-GH") }
                        ] as ColumnDef<FeePlanRow>[]) }
                        data={feePlansQuery.data ?? []}
                        emptyState={<EmptyState description="Platform fee plans will appear here." title="No fee plans yet" />}
                        loading={feePlansQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  },
                  {
                    label: "Merchant overrides",
                    value: "overrides",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "merchant_id", header: "Merchant" },
                          { accessorKey: "name", header: "Override" },
                          { accessorKey: "mode", header: "Mode" },
                          { accessorKey: "kind", header: "Kind" },
                          { accessorKey: "percent_bps", header: "Percent (bps)" },
                          { accessorKey: "updated_at", header: "Updated", cell: ({ row }) => formatDateTime(row.original.updated_at) }
                        ] as ColumnDef<MerchantOverrideRow>[]) }
                        data={merchantOverridesQuery.data ?? []}
                        emptyState={<EmptyState description="Merchant fee overrides will appear here when negotiated pricing is configured." title="No overrides yet" />}
                        loading={merchantOverridesQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  },
                  {
                    label: "FX rates",
                    value: "fx-rates",
                    content: (
                      <DataTable
                        columns={([
                          { accessorKey: "base", header: "Base" },
                          { accessorKey: "quote", header: "Quote" },
                          { accessorKey: "rate", header: "Rate" },
                          { accessorKey: "markup_bps", header: "Markup (bps)" },
                          { accessorKey: "captured_at", header: "Captured", cell: ({ row }) => formatDateTime(row.original.captured_at) }
                        ] as ColumnDef<FxRateRow>[]) }
                        data={fxRatesQuery.data ?? []}
                        emptyState={<EmptyState description="FX rates will appear here once they are entered." title="No FX rates yet" />}
                        loading={fxRatesQuery.isLoading}
                        pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
                      />
                    )
                  }
                ]}
              />
            </>
          ) : null}

          {currentPage === "admin-users" ? (
            <>
              <PageHeader
                action={
                  <Button onClick={() => setAdminUserOpen(true)} variant="primary">
                    Add admin
                  </Button>
                }
                subtitle="View current platform admin users, roles, and activation state."
                title="Admin Users"
              />
              <DataTable
                columns={([
                  { accessorKey: "full_name", header: "Name" },
                  { accessorKey: "email", header: "Email" },
                  { accessorKey: "role", header: "Role" },
                  { accessorKey: "active", header: "Active", cell: ({ row }) => row.original.active ? "Yes" : "No" },
                  { accessorKey: "updated_at", header: "Updated", cell: ({ row }) => formatDateTime(row.original.updated_at) }
                ] as ColumnDef<AdminUserRow>[]) }
                data={adminUsersQuery.data ?? []}
                emptyState={<EmptyState description="Platform admins will appear here once accounts are provisioned." title="No admin users yet" />}
                loading={adminUsersQuery.isLoading}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
              />
            </>
          ) : null}

          {currentPage === "audit" ? (
            <>
              <PageHeader subtitle="Review platform writes by actor, action, and date to verify who changed what and why." title="Audit Logs" />
              <FilterBar
                filters={[
                  <Input key="audit-actor" label="Actor" onChange={(event) => setAuditActorFilter(event.target.value)} value={auditActorFilter} />,
                  <Input key="audit-action" label="Action" onChange={(event) => setAuditActionFilter(event.target.value)} value={auditActionFilter} />,
                  <DateRangePicker key="audit-range" onChange={setDateRange} value={dateRange} />
                ]}
                onReset={() => {
                  setAuditActorFilter("");
                  setAuditActionFilter("");
                  setDateRange(makeDateRangeValue());
                }}
              />
              <DataTable
                columns={([
                  { accessorKey: "created_at", header: "Date", cell: ({ row }) => formatDateTime(row.original.created_at) },
                  { accessorKey: "actor_id", header: "Actor" },
                  { accessorKey: "action", header: "Action" },
                  { accessorKey: "target_type", header: "Target" },
                  { accessorKey: "reason", header: "Reason" }
                ] as ColumnDef<AuditLogRow>[]) }
                data={auditQuery.data ?? []}
                emptyState={<EmptyState description="Audit records will appear here after platform actions are performed." title="No audit logs yet" />}
                loading={auditQuery.isLoading}
                onRowClick={(row) => setSelectedAuditRow(row)}
                pageInfo={{ hasNextPage: false, hasPreviousPage: false, limit: 50 }}
              />
            </>
          ) : null}
        </div>
      </AppShell>

      <Drawer onOpenChange={(open) => !open && setSelectedFlag(null)} open={Boolean(selectedFlag)} title="Compliance flag">
        {selectedFlag ? (
          <div className="space-y-4">
            <CopyField label="Rule" value={selectedFlag.rule_code === "airtime.number_velocity" ? "Airtime velocity" : selectedFlag.rule_code} />
            <CopyField label="Merchant" value={selectedFlag.merchant_id} />
            <Textarea label="Summary" readOnly value={selectedFlag.summary} />
            <Textarea label="Payload" readOnly value={JSON.stringify(selectedFlag.payload ?? {}, null, 2)} />
          </div>
        ) : null}
      </Drawer>

      <Drawer onOpenChange={(open) => !open && setSelectedChannel(null)} open={Boolean(selectedChannel)} title="Channel detail">
        {selectedChannel ? (
          <div className="space-y-4">
            <CopyField label="Channel ID" value={selectedChannel.id} />
            <Textarea label="Config" readOnly value={JSON.stringify(selectedChannel.config ?? {}, null, 2)} />
          </div>
        ) : null}
      </Drawer>

      <Drawer onOpenChange={(open) => !open && setSelectedRule(null)} open={Boolean(selectedRule)} title="Routing rule">
        {selectedRule ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">
                Drag channels to reorder priority. The first row is the primary route.
              </p>
              <div className="space-y-2">
                {selectedRuleChannels.map((channel, index) => (
                  <div
                    key={channel.id}
                    className="flex cursor-grab items-center justify-between rounded-card border border-border bg-surface-subtle px-4 py-3"
                    draggable
                    onDragEnd={() => setDraggedRouteChannelId(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDragStart={() => setDraggedRouteChannelId(channel.id)}
                    onDrop={() => {
                      if (draggedRouteChannelId) {
                        moveRouteChannel(draggedRouteChannelId, channel.id);
                      }
                    }}
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-text">
                        {index + 1}. {channel.provider_code}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {channel.id} · {channel.country_code} · {channel.kind}
                        {channel.network ? ` · ${channel.network}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <StatusBadge status={(index === 0 ? "approved" : "pending") as never} />
                      <p className="mt-1 text-xs text-text-secondary">
                        {index === 0 ? "Primary" : `Priority ${index + 1}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <Textarea label="Reason" onChange={(event) => setRouteReason(event.target.value)} value={routeReason} />
            <Input label="2FA code" onChange={(event) => setRouteCode(event.target.value)} value={routeCode} />
            <Button
              onClick={() => void runSensitiveAction({
                code: routeCode,
                task: async () => {
                  if (!selectedRule) return;
                  await apiRequest("/admin/v1/routing-rules", {
                    accessToken,
                    body: JSON.stringify({
                      capability: selectedRule.capability,
                      channel_ids: routeChannelOrder,
                      country_code: selectedRule.country_code,
                      kind: selectedRule.kind,
                      network: selectedRule.network,
                      reason: routeReason
                    }),
                    method: "POST"
                  });
                  setRouteCode("");
                  setRouteReason("");
                  await queryClient.invalidateQueries({ queryKey: ["admin-routing-rules"] });
                }
              })}
              variant="primary"
            >
              Save routing priority
            </Button>
          </div>
        ) : null}
      </Drawer>

      <Drawer onOpenChange={(open) => !open && setSelectedException(null)} open={Boolean(selectedException)} title="Reconciliation exception">
        {selectedException ? (
          <div className="space-y-4">
            <Textarea label="Summary" readOnly value={JSON.stringify(selectedException, null, 2)} />
            <Input label="Force provider status" onChange={(event) => setForceStatusValue(event.target.value)} value={forceStatusValue} />
            <Textarea label="Reason" onChange={(event) => setResolveReason(event.target.value)} value={resolveReason} />
            <Input label="2FA code for manual adjustment" onChange={(event) => setManualAdjustmentCode(event.target.value)} value={manualAdjustmentCode} />
            <section className="space-y-4 rounded-card border border-border bg-surface-subtle p-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-text">Manual adjustment</h3>
                <p className="text-xs text-text-secondary">
                  Post a ledger-backed adjustment for this exception. This action always requires a fresh 2FA confirmation.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  label="Amount (minor units)"
                  onChange={(event) => setManualAdjustmentAmount(event.target.value)}
                  value={manualAdjustmentAmount}
                />
                <Select
                  label="Currency"
                  onValueChange={(value) => setManualAdjustmentCurrency(value as Currency)}
                  options={currencyOptions}
                  value={manualAdjustmentCurrency}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-3 rounded-card border border-border bg-surface p-4">
                  <p className="text-sm font-medium text-text">Debit account</p>
                  <Select
                    label="Type"
                    onValueChange={(value) => setManualDebitType(value as LedgerAccountType)}
                    options={ledgerAccountTypeOptions}
                    value={manualDebitType}
                  />
                  <Input
                    label="Merchant ID"
                    onChange={(event) => setManualDebitMerchantId(event.target.value)}
                    value={manualDebitMerchantId}
                  />
                  <Input
                    label="Channel ID"
                    onChange={(event) => setManualDebitChannelId(event.target.value)}
                    value={manualDebitChannelId}
                  />
                </div>
                <div className="space-y-3 rounded-card border border-border bg-surface p-4">
                  <p className="text-sm font-medium text-text">Credit account</p>
                  <Select
                    label="Type"
                    onValueChange={(value) => setManualCreditType(value as LedgerAccountType)}
                    options={ledgerAccountTypeOptions}
                    value={manualCreditType}
                  />
                  <Input
                    label="Merchant ID"
                    onChange={(event) => setManualCreditMerchantId(event.target.value)}
                    value={manualCreditMerchantId}
                  />
                  <Input
                    label="Channel ID"
                    onChange={(event) => setManualCreditChannelId(event.target.value)}
                    value={manualCreditChannelId}
                  />
                </div>
              </div>
            </section>
            <div className="flex gap-3">
              <Button
                onClick={async () => {
                  try {
                    await apiRequest(`/admin/v1/reconciliation/exceptions/${selectedException.id}/resolve-force-status`, {
                      accessToken,
                      body: JSON.stringify({
                        provider_status: forceStatusValue,
                        reason: resolveReason
                      }),
                      method: "POST"
                    });
                    await queryClient.invalidateQueries({ queryKey: ["admin-reconciliation-exceptions"] });
                    setSelectedException(null);
                  } catch (error) {
                    pushToast({
                      description: error instanceof ApiError ? error.message : "Unable to resolve the exception.",
                      title: "Resolve failed",
                      variant: "danger"
                    });
                  }
                }}
                variant="primary"
              >
                Force status
              </Button>
              <Button
                onClick={() => void runSensitiveAction({
                  code: manualAdjustmentCode,
                  task: async () => {
                    await apiRequest(`/admin/v1/reconciliation/exceptions/${selectedException.id}/manual-adjustment`, {
                      accessToken,
                      body: JSON.stringify({
                        amount: Number(manualAdjustmentAmount),
                        credit_account: {
                          ...(manualCreditChannelId.trim() ? { channel_id: manualCreditChannelId.trim() } : {}),
                          merchant_id: manualCreditMerchantId.trim() || null,
                          type: manualCreditType
                        },
                        currency: manualAdjustmentCurrency,
                        debit_account: {
                          ...(manualDebitChannelId.trim() ? { channel_id: manualDebitChannelId.trim() } : {}),
                          merchant_id: manualDebitMerchantId.trim() || null,
                          type: manualDebitType
                        },
                        reason: resolveReason
                      }),
                      method: "POST"
                    });
                    await queryClient.invalidateQueries({ queryKey: ["admin-reconciliation-exceptions"] });
                    setManualAdjustmentAmount("");
                    setManualAdjustmentCode("");
                    setResolveReason("");
                    setSelectedException(null);
                  }
                })}
                variant="secondary"
              >
                Manual adjustment
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await apiRequest(`/admin/v1/reconciliation/exceptions/${selectedException.id}/dismiss`, {
                      accessToken,
                      body: JSON.stringify({ reason: resolveReason }),
                      method: "POST"
                    });
                    await queryClient.invalidateQueries({ queryKey: ["admin-reconciliation-exceptions"] });
                    setSelectedException(null);
                  } catch (error) {
                    pushToast({
                      description: error instanceof ApiError ? error.message : "Unable to dismiss the exception.",
                      title: "Dismiss failed",
                      variant: "danger"
                    });
                  }
                }}
                variant="secondary"
              >
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer onOpenChange={(open) => !open && setSelectedSenderIdRow(null)} open={Boolean(selectedSenderIdRow)} title="Sender ID detail">
        {selectedSenderIdRow ? (
          <div className="space-y-4">
            <CopyField label="Authorization letter" value={selectedSenderIdRow.authorization_letter} />
            <Textarea label="Sample message" readOnly value={selectedSenderIdRow.sample_message} />
            <div className="flex gap-3">
              <Button onClick={() => setSenderQueueActionType("submit")} variant="secondary">Mark submitted</Button>
              <Button onClick={() => setSenderQueueActionType("approve")} variant="primary">Approve</Button>
              <Button onClick={() => setSenderQueueActionType("reject")} variant="danger">Reject</Button>
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer onOpenChange={(open) => !open && setSelectedAuditRow(null)} open={Boolean(selectedAuditRow)} title="Audit detail">
        {selectedAuditRow ? <Textarea label="Audit row" readOnly value={JSON.stringify(selectedAuditRow, null, 2)} /> : null}
      </Drawer>

      <Modal onOpenChange={(open) => !open && setKybReviewTarget(null)} open={Boolean(kybReviewTarget)} title="Review KYB">
        <div className="space-y-4">
          <Select
            label="Decision"
            onValueChange={(value) => setKybReviewStatus(value as "approved" | "pending" | "rejected")}
            options={[
              { label: "Approve", value: "approved" },
              { label: "Reject", value: "rejected" },
              { label: "Request more information", value: "pending" }
            ]}
            value={kybReviewStatus}
          />
          <Textarea label="Review note" onChange={(event) => setKybReviewNote(event.target.value)} value={kybReviewNote} />
          <Button
            onClick={async () => {
              if (!kybReviewTarget) return;
              try {
                await apiRequest(`/admin/v1/merchants/${kybReviewTarget.merchant_id}/kyb/review`, {
                  accessToken,
                  body: JSON.stringify({
                    mode: kybReviewTarget.mode,
                    reason: kybReviewNote,
                    review_note: kybReviewNote,
                    status: kybReviewStatus
                  }),
                  method: "POST"
                });
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["admin-kyb-queue"] }),
                  queryClient.invalidateQueries({ queryKey: ["admin-merchant-kyb"] })
                ]);
                setKybReviewTarget(null);
              } catch (error) {
                pushToast({
                  description: error instanceof ApiError ? error.message : "Unable to submit the KYB review.",
                  title: "Review failed",
                  variant: "danger"
                });
              }
            }}
            variant="primary"
          >
            Submit review
          </Button>
        </div>
      </Modal>

      <Modal onOpenChange={setFxModalOpen} open={fxModalOpen} title="Create FX rate">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Select label="Base" onValueChange={setFxBase} options={[{ label: "GHS", value: "GHS" }, { label: "USD", value: "USD" }, { label: "ZMW", value: "ZMW" }]} value={fxBase} />
            <Select label="Quote" onValueChange={setFxQuote} options={[{ label: "GHS", value: "GHS" }, { label: "USD", value: "USD" }, { label: "ZMW", value: "ZMW" }]} value={fxQuote} />
          </div>
          <Input label="Rate" onChange={(event) => setFxRate(event.target.value)} value={fxRate} />
          <Input label="Markup (bps)" onChange={(event) => setFxMarkup(event.target.value)} value={fxMarkup} />
          <Textarea label="Reason" onChange={(event) => setFxReason(event.target.value)} value={fxReason} />
          <Input label="2FA code" onChange={(event) => setFxCode(event.target.value)} value={fxCode} />
          <Button
            onClick={() => void runSensitiveAction({
              code: fxCode,
              task: async () => {
                await apiRequest("/admin/v1/pricing/fx-rates", {
                  accessToken,
                  body: JSON.stringify({
                    base: fxBase,
                    captured_at: new Date().toISOString(),
                    markup_bps: Number(fxMarkup),
                    quote: fxQuote,
                    rate: fxRate,
                    reason: fxReason
                  }),
                  method: "POST"
                });
                setFxModalOpen(false);
                setFxCode("");
                setFxReason("");
                await queryClient.invalidateQueries({ queryKey: ["admin-fx-rates"] });
              }
            })}
            variant="primary"
          >
            Save FX rate
          </Button>
        </div>
      </Modal>

      <Modal onOpenChange={(open) => !open && setSenderQueueActionType(null)} open={Boolean(senderQueueActionType && selectedSenderIdRow)} title="Sender ID action">
        <div className="space-y-4">
          <Textarea label="Reason" onChange={(event) => setSenderQueueReason(event.target.value)} value={senderQueueReason} />
          <Input label="2FA code" onChange={(event) => setSenderQueueCode(event.target.value)} value={senderQueueCode} />
          <Button
            onClick={() => void runSensitiveAction({
              code: senderQueueCode,
              task: async () => {
                if (!selectedSenderIdRow || !senderQueueActionType) return;
                await apiRequest(`/admin/v1/sms/sender-ids/${selectedSenderIdRow.approval_id}/${senderQueueActionType === "submit" ? "submit" : senderQueueActionType}`, {
                  accessToken,
                  body: JSON.stringify({ reason: senderQueueReason }),
                  method: "POST"
                });
                setSenderQueueActionType(null);
                setSenderQueueCode("");
                setSenderQueueReason("");
                await queryClient.invalidateQueries({ queryKey: ["admin-sender-ids"] });
              }
            })}
            variant={senderQueueActionType === "reject" ? "danger" : "primary"}
          >
            Confirm action
          </Button>
        </div>
      </Modal>
      <CreateAdminUserModal
        accessToken={accessToken}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ["admin-users"] })}
        onOpenChange={setAdminUserOpen}
        open={adminUserOpen}
      />
    </>
  );
}

function AirtimeFloatHistoryChart({
  currency,
  points
}: {
  currency: string;
  points: AirtimeFloatHistoryRow[];
}) {
  const maxBalance = Math.max(
    1,
    ...points.map((point) => point.balance_minor ?? 0),
    ...points.map((point) => point.threshold_minor)
  );

  if (points.length === 0) {
    return <EmptyState description="History appears after the float monitor writes snapshots." title="No float history yet" />;
  }

  return (
    <section className="space-y-3 rounded-card border border-border bg-surface-subtle p-4">
      <p className="text-sm font-medium text-text">Float history</p>
      <div className="flex h-32 items-end gap-1">
        {points.map((point) => {
          const height = Math.max(6, Math.round(((point.balance_minor ?? 0) / maxBalance) * 100));
          const low = point.status === "low" || point.status === "empty";
          return (
            <div
              key={point.id}
              className={`min-w-0 flex-1 rounded-t ${low ? "bg-brand-600" : "bg-brand-200"}`}
              style={{ height: `${height}%` }}
              title={`${formatDateTime(point.checked_at)} · ${point.balance_minor === null ? "unknown" : formatMoney(BigInt(point.balance_minor), (point.currency ?? currency) as never, "en-GH")}`}
            />
          );
        })}
      </div>
      <p className="text-xs text-text-secondary">
        Latest {points[points.length - 1]?.balance_minor === null
          ? "-"
          : formatMoney(BigInt(points[points.length - 1]?.balance_minor ?? 0), (points[points.length - 1]?.currency ?? currency) as never, "en-GH")}
        {" "}
        · threshold {formatMoney(BigInt(points[points.length - 1]?.threshold_minor ?? 0), currency as never, "en-GH")}
      </p>
    </section>
  );
}

function MerchantAirtimeLimitsForm({
  accessToken,
  limits,
  merchantId,
  onSaved
}: {
  accessToken: string;
  limits: AirtimeLimitsRow;
  merchantId: string;
  onSaved: () => void;
}) {
  const { pushToast } = useToast();
  const [merchantCap, setMerchantCap] = React.useState(String(limits.merchant_daily_cap_minor));
  const [numberCap, setNumberCap] = React.useState(String(limits.number_daily_cap_minor));
  const [velocity, setVelocity] = React.useState(String(limits.velocity_per_number));
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setMerchantCap(String(limits.merchant_daily_cap_minor));
    setNumberCap(String(limits.number_daily_cap_minor));
    setVelocity(String(limits.velocity_per_number));
  }, [limits]);

  return (
    <section className="space-y-4 rounded-card border border-border bg-white p-4">
      <div>
        <h3 className="text-base font-semibold text-text">Airtime limits</h3>
        <p className="mt-1 text-sm text-text-secondary">
          Daily caps per merchant and per recipient number. A reason is required and the change is audited.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Input label="Merchant daily cap (minor units)" onChange={(event) => setMerchantCap(event.target.value)} value={merchantCap} />
        <Input label="Number daily cap (minor units)" onChange={(event) => setNumberCap(event.target.value)} value={numberCap} />
        <Input label="Velocity per number" onChange={(event) => setVelocity(event.target.value)} value={velocity} />
      </div>
      <Input label="Reason" onChange={(event) => setReason(event.target.value)} value={reason} />
      <Button
        loading={saving}
        onClick={() => {
          if (!reason.trim() || saving) {
            return;
          }
          setSaving(true);
          void apiRequest(`/admin/v1/merchants/${merchantId}/airtime-limits`, {
            accessToken,
            body: JSON.stringify({
              merchant_daily_cap_minor: Number(merchantCap),
              mode: limits.mode,
              number_daily_cap_minor: Number(numberCap),
              reason,
              velocity_per_number: Number(velocity)
            }),
            method: "PUT"
          })
            .then(() => {
              pushToast({ description: "Airtime limits were saved.", title: "Limits updated", variant: "success" });
              onSaved();
            })
            .catch((error: unknown) => {
              pushToast({
                description: error instanceof ApiError ? error.message : "Unable to update airtime limits.",
                title: "Update failed",
                variant: "danger"
              });
            })
            .finally(() => setSaving(false));
        }}
        variant="primary"
      >
        Save airtime limits
      </Button>
    </section>
  );
}

function MerchantFeatureForm({
  accessToken,
  detail,
  onSaved
}: {
  accessToken: string;
  detail: MerchantDetailData;
  onSaved: () => void;
}) {
  const { pushToast } = useToast();
  const [collections, setCollections] = React.useState(detail.products.collections_enabled);
  const [payouts, setPayouts] = React.useState(detail.products.payouts_enabled);
  const [smsBroadcast, setSmsBroadcast] = React.useState(detail.products.sms_broadcast_enabled);
  const [smsApi, setSmsApi] = React.useState(detail.products.sms_api_enabled);
  const [airtime, setAirtime] = React.useState(detail.products.airtime_enabled);
  const [collectionMax, setCollectionMax] = React.useState("1000000");
  const [payoutMax, setPayoutMax] = React.useState("1000000");
  const [airtimeMerchantCap, setAirtimeMerchantCap] = React.useState("10000000");
  const [airtimeNumberCap, setAirtimeNumberCap] = React.useState("100000");
  const [airtimeVelocity, setAirtimeVelocity] = React.useState("5");
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setCollections(detail.products.collections_enabled);
    setPayouts(detail.products.payouts_enabled);
    setSmsBroadcast(detail.products.sms_broadcast_enabled);
    setSmsApi(detail.products.sms_api_enabled);
    setAirtime(detail.products.airtime_enabled);
  }, [detail]);

  React.useEffect(() => {
    let cancelled = false;
    void apiRequest<AirtimeLimitsRow>(`/admin/v1/merchants/${detail.id}/airtime-limits?mode=${detail.mode}`, {
      accessToken
    })
      .then((limits) => {
        if (cancelled) {
          return;
        }
        setAirtimeMerchantCap(String(limits.merchant_daily_cap_minor));
        setAirtimeNumberCap(String(limits.number_daily_cap_minor));
        setAirtimeVelocity(String(limits.velocity_per_number));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, detail.id, detail.mode]);

  return (
    <section className="mt-4 space-y-4 rounded-card border border-border bg-white p-4">
      <div>
        <h3 className="text-base font-semibold text-text">Assigned products</h3>
        <p className="mt-1 text-sm text-text-secondary">
          The merchant dashboard only shows the products you enable. Live money movement still requires an active KYB status.
        </p>
      </div>
      <Checkbox
        checked={collections}
        label={detail.products.collections_requested ? "Collections (requested)" : "Collections"}
        onChange={() => setCollections((current) => !current)}
      />
      <Checkbox
        checked={payouts}
        label={detail.products.payouts_requested ? "Payouts (requested)" : "Payouts"}
        onChange={() => setPayouts((current) => !current)}
      />
      <Checkbox
        checked={smsBroadcast}
        label={detail.products.sms_requested ? "SMS broadcast (requested)" : "SMS broadcast"}
        onChange={() => setSmsBroadcast((current) => !current)}
      />
      <Checkbox
        checked={smsApi}
        label={detail.products.sms_requested ? "SMS API (requested)" : "SMS API"}
        onChange={() => setSmsApi((current) => !current)}
      />
      <Checkbox
        checked={airtime}
        label={detail.products.airtime_requested ? "Send airtime (requested)" : "Send airtime"}
        onChange={() => setAirtime((current) => !current)}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Input label="Collection maximum (minor units)" onChange={(event) => setCollectionMax(event.target.value)} value={collectionMax} />
        <Input label="Payout maximum (minor units)" onChange={(event) => setPayoutMax(event.target.value)} value={payoutMax} />
        <Input label="Airtime merchant daily cap (minor units)" onChange={(event) => setAirtimeMerchantCap(event.target.value)} value={airtimeMerchantCap} />
        <Input label="Airtime number daily cap (minor units)" onChange={(event) => setAirtimeNumberCap(event.target.value)} value={airtimeNumberCap} />
        <Input label="Airtime velocity per number" onChange={(event) => setAirtimeVelocity(event.target.value)} value={airtimeVelocity} />
      </div>
      <Input label="Reason" onChange={(event) => setReason(event.target.value)} value={reason} />
      <Button
        loading={saving}
        onClick={() => {
          if (!reason.trim() || saving) {
            return;
          }
          setSaving(true);
          void Promise.all([
            apiRequest(`/admin/v1/merchants/${detail.id}/products`, {
              accessToken,
              body: JSON.stringify({
                airtime_enabled: airtime,
                collections_enabled: collections,
                mode: detail.mode,
                payouts_enabled: payouts,
                reason,
                sms_api_enabled: smsApi,
                sms_broadcast_enabled: smsBroadcast
              }),
              method: "PUT"
            }),
            apiRequest(`/admin/v1/merchants/${detail.id}/limits`, {
              accessToken,
              body: JSON.stringify({
                collections_max_minor: Number(collectionMax),
                mode: detail.mode,
                payouts_max_minor: Number(payoutMax),
                reason
              }),
              method: "PUT"
            }),
            apiRequest(`/admin/v1/merchants/${detail.id}/airtime-limits`, {
              accessToken,
              body: JSON.stringify({
                merchant_daily_cap_minor: Number(airtimeMerchantCap),
                mode: detail.mode,
                number_daily_cap_minor: Number(airtimeNumberCap),
                reason,
                velocity_per_number: Number(airtimeVelocity)
              }),
              method: "PUT"
            })
          ])
            .then(() => {
              pushToast({ description: "Product access and limits were saved.", title: "Merchant updated", variant: "success" });
              onSaved();
            })
            .catch((error: unknown) => {
              pushToast({
                description: error instanceof ApiError ? error.message : "Unable to update this merchant.",
                title: "Update failed",
                variant: "danger"
              });
            })
            .finally(() => setSaving(false));
        }}
        variant="primary"
      >
        Save products and limits
      </Button>
    </section>
  );
}

function CreateAdminUserModal({
  accessToken,
  onCreated,
  onOpenChange,
  open
}: {
  accessToken: string;
  onCreated: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { pushToast } = useToast();
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState("operations");
  const [saving, setSaving] = React.useState(false);

  return (
    <Modal onOpenChange={onOpenChange} open={open} title="Add admin user">
      <div className="space-y-4">
        <Input label="Full name" onChange={(event) => setFullName(event.target.value)} value={fullName} />
        <Input label="Email" onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
        <Input label="Temporary password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        <Select
          label="Role"
          onValueChange={setRole}
          options={[
            { label: "Super admin", value: "super_admin" },
            { label: "Compliance", value: "compliance" },
            { label: "Operations", value: "operations" },
            { label: "Finance", value: "finance" },
            { label: "Support", value: "support" }
          ]}
          value={role}
        />
        <Button
          loading={saving}
          onClick={() => {
            if (saving) return;
            setSaving(true);
            void apiRequest("/admin/v1/admin-users", {
              accessToken,
              body: JSON.stringify({ email, full_name: fullName, password, role }),
              method: "POST"
            })
              .then(() => {
                pushToast({ description: "The admin can sign in and enroll 2FA.", title: "Admin created", variant: "success" });
                onOpenChange(false);
                onCreated();
              })
              .catch((error: unknown) => {
                pushToast({
                  description: error instanceof ApiError ? error.message : "Unable to create the admin.",
                  title: "Create admin failed",
                  variant: "danger"
                });
              })
              .finally(() => setSaving(false));
          }}
          variant="primary"
        >
          Create admin
        </Button>
      </div>
    </Modal>
  );
}
