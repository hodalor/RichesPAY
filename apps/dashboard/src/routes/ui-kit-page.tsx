import * as React from "react";
import {
  ArrowUpRight,
  CreditCard,
  Landmark,
  MessagesSquare,
  Wallet
} from "lucide-react";
import { useLocation } from "react-router-dom";

import {
  AppShell,
  Button,
  CopyField,
  DataTable,
  DateRangePicker,
  Drawer,
  FilterBar,
  MoneyText,
  PageHeader,
  Select,
  StatusBadge,
  SummaryCard,
  SummaryCardGrid,
  Tabs,
  Tooltip,
  type ColumnDef,
  type DataTablePageInfo,
  type DateRangeValue,
  type SortingState,
  type StatusValue
} from "@richespay/ui";

type Channel = "Card" | "MTN MoMo" | "Airtel Money" | "Telecel Cash";

interface TransactionRow {
  amountMinor: bigint;
  channel: Channel;
  createdAt: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  id: string;
  mode: "test" | "live";
  reference: string;
  settlementCurrency: "GHS";
  status: Extract<
    StatusValue,
    "pending" | "processing" | "successful" | "failed" | "reversed" | "expired"
  >;
}

const channels: readonly Channel[] = [
  "MTN MoMo",
  "Card",
  "Airtel Money",
  "Telecel Cash"
];

const statuses: readonly TransactionRow["status"][] = [
  "successful",
  "processing",
  "pending",
  "failed",
  "reversed",
  "expired"
];

const statusOptions = [
  { label: "All statuses", value: "all" },
  { label: "Successful", value: "successful" },
  { label: "Processing", value: "processing" },
  { label: "Pending", value: "pending" },
  { label: "Failed", value: "failed" },
  { label: "Reversed", value: "reversed" },
  { label: "Expired", value: "expired" }
] as const;

const channelOptions = [
  { label: "All channels", value: "all" },
  { label: "MTN MoMo", value: "MTN MoMo" },
  { label: "Card", value: "Card" },
  { label: "Airtel Money", value: "Airtel Money" },
  { label: "Telecel Cash", value: "Telecel Cash" }
] as const;

const pageSize = 10;

function buildTransactions(): TransactionRow[] {
  return Array.from({ length: 50 }, (_, index) => {
    const sequence = index + 1;
    const status = statuses[index % statuses.length];
    const channel = channels[index % channels.length];
    const createdAt = new Date(
      Date.UTC(2026, 8, 26 - (index % 28), 8 + (index % 12), (index * 7) % 60)
    ).toISOString();

    return {
      amountMinor: BigInt(4200 + sequence * 175),
      channel,
      createdAt,
      customerEmail: `merchant${sequence}@example.com`,
      customerName: `Customer ${sequence}`,
      customerPhone: `+233240000${sequence.toString().padStart(3, "0")}`,
      id: `col_01K5KIT${sequence.toString().padStart(6, "0")}GH`,
      mode: sequence % 5 === 0 ? "live" : "test",
      reference: `txn-demo-${sequence.toString().padStart(4, "0")}`,
      settlementCurrency: "GHS",
      status
    };
  });
}

function toLocalDate(isoString: string): string {
  return new Intl.DateTimeFormat("en-GH", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(isoString));
}

function getDateRangeBounds(
  value: DateRangeValue
): { end: Date; start: Date } | null {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday);
  endOfToday.setHours(23, 59, 59, 999);

  switch (value.preset) {
    case "today":
      return {
        end: endOfToday,
        start: startOfToday
      };
    case "seven_days": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 6);
      return { end: endOfToday, start };
    }
    case "thirty_days": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 29);
      return { end: endOfToday, start };
    }
    case "this_month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return { end, start };
    }
    case "custom":
      if (!value.startDate || !value.endDate) {
        return null;
      }

      return {
        end: new Date(`${value.endDate}T23:59:59.999`),
        start: new Date(`${value.startDate}T00:00:00.000`)
      };
    default:
      return null;
  }
}

export function UIKitPage() {
  const location = useLocation();
  const [mode, setMode] = React.useState<"test" | "live">("test");
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [channelFilter, setChannelFilter] = React.useState("all");
  const [dateRange, setDateRange] = React.useState<DateRangeValue>({
    preset: "thirty_days"
  });
  const [sorting, setSorting] = React.useState<SortingState>([
    { desc: true, id: "createdAt" }
  ]);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [selectedTransaction, setSelectedTransaction] =
    React.useState<TransactionRow | null>(null);

  const transactions = React.useMemo(() => buildTransactions(), []);

  const filteredTransactions = React.useMemo(() => {
    const searchTerm = search.trim().toLowerCase();
    const bounds = getDateRangeBounds(dateRange);

    const result = transactions.filter((transaction) => {
      const matchesSearch =
        searchTerm === "" ||
        [
          transaction.id,
          transaction.reference,
          transaction.customerName,
          transaction.customerEmail,
          transaction.customerPhone
        ].some((value) => value.toLowerCase().includes(searchTerm));

      const matchesStatus =
        statusFilter === "all" || transaction.status === statusFilter;
      const matchesChannel =
        channelFilter === "all" || transaction.channel === channelFilter;
      const matchesMode = transaction.mode === mode;

      const createdAt = new Date(transaction.createdAt);
      const matchesDate =
        !bounds || (createdAt >= bounds.start && createdAt <= bounds.end);

      return (
        matchesSearch &&
        matchesStatus &&
        matchesChannel &&
        matchesMode &&
        matchesDate
      );
    });

    if (sorting.length === 0) {
      return result;
    }

    const [{ desc, id }] = sorting;
    return [...result].sort((left, right) => {
      let comparison = 0;

      if (id === "createdAt") {
        comparison =
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      }

      if (id === "amountMinor") {
        comparison =
          left.amountMinor < right.amountMinor
            ? -1
            : left.amountMinor > right.amountMinor
              ? 1
              : 0;
      }

      if (id === "status") {
        comparison = left.status.localeCompare(right.status);
      }

      return desc ? comparison * -1 : comparison;
    });
  }, [channelFilter, dateRange, mode, search, sorting, statusFilter, transactions]);

  React.useEffect(() => {
    setPageIndex(0);
  }, [channelFilter, dateRange, mode, search, sorting, statusFilter]);

  const pagedTransactions = React.useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredTransactions.slice(start, start + pageSize);
  }, [filteredTransactions, pageIndex]);

  const pageInfo = React.useMemo<DataTablePageInfo>(() => {
    const start = pageIndex * pageSize;
    const end = start + pageSize;

    return {
      endCursor: pagedTransactions.at(-1)?.id,
      hasNextPage: end < filteredTransactions.length,
      hasPreviousPage: pageIndex > 0,
      limit: pageSize,
      startCursor: pagedTransactions[0]?.id
    };
  }, [filteredTransactions.length, pageIndex, pagedTransactions]);

  const totals = React.useMemo(() => {
    const gross = filteredTransactions.reduce(
      (sum, transaction) => sum + transaction.amountMinor,
      0n
    );
    const successful = filteredTransactions.filter(
      (transaction) => transaction.status === "successful"
    ).length;
    const processing = filteredTransactions.filter(
      (transaction) => transaction.status === "processing"
    ).length;
    const successRate =
      filteredTransactions.length === 0
        ? 0
        : (successful / filteredTransactions.length) * 100;

    return {
      gross,
      processing,
      successRate,
      successful,
      total: filteredTransactions.length
    };
  }, [filteredTransactions]);

  const columns = React.useMemo<ColumnDef<TransactionRow>[]>(
    () => [
      {
        accessorKey: "id",
        header: "Transaction",
        cell: ({ row }) => (
          <div className="space-y-1">
            <p className="font-medium text-text">{row.original.id}</p>
            <p className="text-xs text-text-secondary">{row.original.reference}</p>
          </div>
        )
      },
      {
        accessorKey: "customerName",
        header: "Customer",
        cell: ({ row }) => (
          <div className="space-y-1">
            <p className="font-medium text-text">{row.original.customerName}</p>
            <p className="text-xs text-text-secondary">
              {row.original.customerEmail}
            </p>
          </div>
        )
      },
      {
        accessorKey: "channel",
        header: "Channel",
        cell: ({ row }) => (
          <div className="inline-flex items-center gap-2">
            <span className="text-text-secondary">
              {row.original.channel === "Card" ? (
                <CreditCard className="size-4" />
              ) : (
                <Wallet className="size-4" />
              )}
            </span>
            <span>{row.original.channel}</span>
          </div>
        )
      },
      {
        accessorKey: "amountMinor",
        header: "Amount",
        cell: ({ row }) => (
          <MoneyText
            amountMinor={row.original.amountMinor}
            currency={row.original.settlementCurrency}
          />
        )
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <div className="space-y-1">
            <p className="font-medium text-text">{toLocalDate(row.original.createdAt)}</p>
            <p className="text-xs text-text-secondary">UTC stored</p>
          </div>
        )
      }
    ],
    []
  );

  return (
    <AppShell
      activePath={location.pathname}
      mode={mode}
      navItems={[
        { href: "/", icon: <Landmark className="size-4" />, label: "Overview" },
        {
          href: "/ui-kit",
          icon: <MessagesSquare className="size-4" />,
          label: "UI Kit"
        }
      ]}
      onModeChange={setMode}
      title="RichesPay"
      topBarContent={
        <Tooltip content="Calm, premium list-page composition for merchant operations.">
          <div className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary">
            Design system preview
          </div>
        </Tooltip>
      }
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          action={
            <Button leadingIcon={<ArrowUpRight className="size-4" />} variant="primary">
              Create payment link
            </Button>
          }
          subtitle="A polished sample transaction list page using the RichesPay design system. White surfaces stay dominant, orange is reserved for the single primary action, and the details live in a side drawer."
          title="Transactions"
        />

        <SummaryCardGrid columns={4}>
          <SummaryCard
            changePercent={12.4}
            icon={<Wallet className="size-5" />}
            label="Gross volume"
            value={<MoneyText amountMinor={totals.gross} currency="GHS" />}
          />
          <SummaryCard
            changePercent={6.8}
            icon={<CreditCard className="size-5" />}
            label="Successful collections"
            value={totals.successful.toLocaleString("en-GH")}
          />
          <SummaryCard
            changePercent={-2.3}
            icon={<MessagesSquare className="size-5" />}
            label="Processing now"
            value={totals.processing.toLocaleString("en-GH")}
          />
          <SummaryCard
            changePercent={3.1}
            icon={<Landmark className="size-5" />}
            label="Success rate"
            value={`${totals.successRate.toFixed(1)}%`}
          />
        </SummaryCardGrid>

        <FilterBar
          filters={[
            <Select
              key="status"
              label="Status"
              onValueChange={setStatusFilter}
              options={statusOptions}
              value={statusFilter}
            />,
            <DateRangePicker
              key="date-range"
              label="Date range"
              onChange={setDateRange}
              value={dateRange}
            />,
            <Select
              key="channel"
              label="Channel"
              onValueChange={setChannelFilter}
              options={channelOptions}
              value={channelFilter}
            />
          ] as const}
          onReset={() => {
            setSearch("");
            setStatusFilter("all");
            setChannelFilter("all");
            setDateRange({ preset: "thirty_days" });
          }}
          onSearchChange={setSearch}
          placeholder="Search by id, reference, customer or phone"
          searchValue={search}
        />

        <DataTable
          columns={columns}
          data={pagedTransactions}
          emptyState={
            <div className="py-6">
              <p className="text-center text-sm text-text-secondary">
                No transactions match the current filters.
              </p>
            </div>
          }
          onNextPage={() => {
            setPageIndex((current) => current + 1);
          }}
          onPreviousPage={() => {
            setPageIndex((current) => Math.max(0, current - 1));
          }}
          onRowClick={setSelectedTransaction}
          pageInfo={pageInfo}
          rowId={(row) => row.id}
          sorting={sorting}
          onSortingChange={setSorting}
        />
      </div>

      <Drawer
        description="Transaction detail drawer for list-row drill down."
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTransaction(null);
          }
        }}
        open={selectedTransaction !== null}
        title={selectedTransaction?.id ?? "Transaction detail"}
      >
        {selectedTransaction ? (
          <div className="space-y-6">
            <div className="grid gap-4 rounded-card border border-border bg-surface-subtle p-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-text-secondary">Status</p>
                <div className="mt-2">
                  <StatusBadge status={selectedTransaction.status} />
                </div>
              </div>
              <div>
                <p className="text-sm text-text-secondary">Amount</p>
                <p className="mt-2 text-xl font-semibold text-text">
                  <MoneyText
                    amountMinor={selectedTransaction.amountMinor}
                    currency={selectedTransaction.settlementCurrency}
                  />
                </p>
              </div>
            </div>

            <Tabs
              defaultValue="details"
              items={[
                {
                  value: "details",
                  label: "Details",
                  content: (
                    <div className="space-y-4">
                      <CopyField label="Collection id" value={selectedTransaction.id} />
                      <CopyField label="Reference" value={selectedTransaction.reference} />
                      <div className="grid gap-4 rounded-card border border-border bg-surface-subtle p-4 sm:grid-cols-2">
                        <div>
                          <p className="text-sm text-text-secondary">Customer</p>
                          <p className="mt-1 font-medium text-text">
                            {selectedTransaction.customerName}
                          </p>
                          <p className="mt-1 text-sm text-text-secondary">
                            {selectedTransaction.customerEmail}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-text-secondary">Channel</p>
                          <p className="mt-1 font-medium text-text">
                            {selectedTransaction.channel}
                          </p>
                          <p className="mt-1 text-sm text-text-secondary">
                            {selectedTransaction.customerPhone}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                },
                {
                  value: "timeline",
                  label: "Timeline",
                  content: (
                    <div className="space-y-3 rounded-card border border-border bg-surface-subtle p-4">
                      <div className="rounded-input bg-surface px-4 py-3">
                        <p className="text-sm font-medium text-text">Received</p>
                        <p className="mt-1 text-sm text-text-secondary">
                          {toLocalDate(selectedTransaction.createdAt)}
                        </p>
                      </div>
                      <div className="rounded-input bg-surface px-4 py-3">
                        <p className="text-sm font-medium text-text">Mode</p>
                        <p className="mt-1 text-sm text-text-secondary">
                          {selectedTransaction.mode === "test"
                            ? "Test traffic routed to simulator"
                            : "Live traffic"}
                        </p>
                      </div>
                    </div>
                  )
                }
              ]}
            />
          </div>
        ) : null}
      </Drawer>
    </AppShell>
  );
}
