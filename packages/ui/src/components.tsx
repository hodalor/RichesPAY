import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as RadixSelect from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as RadixToast from "@radix-ui/react-toast";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Menu,
  PanelLeft,
  Search,
  X
} from "lucide-react";
import {
  type ColumnDef,
  type RowData,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";

import { formatMoney, type CurrencyCode } from "@richespay/shared";

import { cn, formatPercentChange } from "./lib/utils";

type UpToThree<T> = readonly [] | readonly [T] | readonly [T, T] | readonly [T, T, T];
type Variant = "primary" | "secondary" | "ghost" | "danger";
type ToastVariant = "info" | "success" | "warning" | "danger";
type PageMode = "test" | "live";

const buttonVariants: Record<Variant, string> = {
  primary:
    "bg-brand text-white shadow-soft hover:bg-brand-hover focus-visible:ring-brand/25",
  secondary:
    "bg-surface text-text border border-border hover:border-border-strong hover:bg-surface-subtle focus-visible:ring-brand/15",
  ghost:
    "bg-transparent text-text-secondary hover:bg-surface-subtle hover:text-text focus-visible:ring-brand/15",
  danger:
    "bg-danger text-white shadow-soft hover:bg-danger/90 focus-visible:ring-danger/20"
};

const statusBadgeStyles = {
  pending: "bg-warning-soft text-warning",
  processing: "bg-info-soft text-info",
  successful: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  reversed: "bg-neutral-soft text-neutral",
  expired: "bg-neutral-soft text-neutral",
  frozen: "bg-neutral-soft text-text",
  delivered: "bg-success-soft text-success",
  undelivered: "bg-danger-soft text-danger"
} as const;

const statusLabelMap = {
  pending: "Pending",
  processing: "Processing",
  successful: "Successful",
  failed: "Failed",
  reversed: "Reversed",
  expired: "Expired",
  frozen: "Frozen",
  delivered: "Delivered",
  undelivered: "Undelivered"
} as const;

export type StatusValue = keyof typeof statusBadgeStyles;

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className,
      disabled,
      leadingIcon,
      loading = false,
      type = "button",
      variant = "secondary",
      ...props
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-input px-4 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-60",
          buttonVariants[variant],
          className
        )}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          leadingIcon
        )}
        <span>{children}</span>
      </button>
    );
  }
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, label, ...props }, ref) {
    return (
      <label className="flex w-full flex-col gap-2 text-sm">
        {label ? (
          <span className="font-medium text-text-secondary">{label}</span>
        ) : null}
        <input
          ref={ref}
          className={cn(
            "h-11 w-full rounded-input border border-border bg-surface px-3 text-sm text-text shadow-softer outline-none transition placeholder:text-text-muted focus:border-brand/30 focus:ring-4 focus:ring-brand/10",
            className
          )}
          {...props}
        />
      </label>
    );
  }
);

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps {
  label?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  value?: string;
}

export function Select({
  label,
  onValueChange,
  options,
  placeholder = "Select option",
  value
}: SelectProps) {
  return (
    <label className="flex min-w-[180px] flex-col gap-2 text-sm">
      {label ? (
        <span className="font-medium text-text-secondary">{label}</span>
      ) : null}
      <RadixSelect.Root onValueChange={onValueChange} value={value}>
        <RadixSelect.Trigger className="inline-flex h-11 items-center justify-between gap-3 rounded-input border border-border bg-surface px-3 text-left text-sm text-text shadow-softer outline-none transition focus:ring-4 focus:ring-brand/10">
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon className="text-text-muted">
            <ChevronDown className="size-4" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            className="z-50 overflow-hidden rounded-card border border-border bg-surface p-1 shadow-soft"
            position="popper"
          >
            <RadixSelect.Viewport className="space-y-1 p-1">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  className="relative flex cursor-pointer select-none items-center rounded-input px-8 py-2.5 text-sm text-text outline-none hover:bg-surface-subtle focus:bg-surface-subtle"
                  value={option.value}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="absolute left-2 text-brand">
                    <Check className="size-4" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </label>
  );
}

export interface TabsItem {
  content: React.ReactNode;
  label: string;
  value: string;
}

export interface TabsProps {
  defaultValue?: string;
  items: readonly TabsItem[];
}

export function Tabs({ defaultValue, items }: TabsProps) {
  return (
    <RadixTabs.Root
      className="flex flex-col gap-4"
      defaultValue={defaultValue ?? items[0]?.value}
    >
      <RadixTabs.List className="inline-flex w-fit rounded-card border border-border bg-surface p-1">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            className="rounded-input px-3 py-2 text-sm font-medium text-text-secondary outline-none transition data-[state=active]:bg-brand-50 data-[state=active]:text-brand focus:ring-4 focus:ring-brand/10"
            value={item.value}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content
          key={item.value}
          className="outline-none"
          value={item.value}
        >
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
}

export function Tooltip({ children, content }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={100}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="z-50 rounded-input bg-text px-3 py-2 text-xs text-white shadow-soft"
            sideOffset={8}
          >
            {content}
            <RadixTooltip.Arrow className="fill-text" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

export interface EmptyStateProps {
  action?: React.ReactNode;
  description: string;
  icon?: React.ReactNode;
  title: string;
}

export function EmptyState({
  action,
  description,
  icon = <ArrowRight className="size-5" />,
  title
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-border bg-surface-subtle px-6 py-12 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface text-text-secondary">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-text">{title}</h3>
      <p className="mt-2 max-w-md text-sm text-text-secondary">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export interface PageHeaderProps {
  action?: React.ReactNode;
  subtitle?: string;
  title: string;
}

export function PageHeader({ action, subtitle, title }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight text-text">{title}</h1>
        {subtitle ? (
          <p className="max-w-3xl text-sm text-text-secondary">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block animate-pulse rounded-input bg-surface-subtle",
        className
      )}
    />
  );
}

export interface SummaryCardProps {
  changePercent?: number;
  icon?: React.ReactNode;
  label: string;
  loading?: boolean;
  value: React.ReactNode;
}

export function SummaryCard({
  changePercent,
  icon,
  label,
  loading = false,
  value
}: SummaryCardProps) {
  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-softer">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          {loading ? (
            <>
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-8 w-32" />
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-text-secondary">{label}</p>
              <p className="text-2xl font-semibold tracking-tight text-text">
                {value}
              </p>
            </>
          )}
        </div>
        <div className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-brand">
          {icon}
        </div>
      </div>
      {loading ? (
        <SkeletonBlock className="mt-6 h-3 w-24" />
      ) : changePercent !== undefined ? (
        <p className="mt-6 text-sm text-text-secondary">
          <span
            className={cn(
              "font-medium",
              changePercent >= 0 ? "text-success" : "text-danger"
            )}
          >
            {formatPercentChange(changePercent)}
          </span>{" "}
          vs last period
        </p>
      ) : null}
    </section>
  );
}

export interface SummaryCardGridProps {
  children: React.ReactNode;
  columns?: 3 | 4;
}

export function SummaryCardGrid({
  children,
  columns = 4
}: SummaryCardGridProps) {
  return (
    <div
      className={cn(
        "grid gap-4",
        columns === 4 ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-4" : "grid-cols-1 md:grid-cols-3"
      )}
    >
      {children}
    </div>
  );
}

export interface DateRangeValue {
  endDate?: string;
  preset: "today" | "seven_days" | "thirty_days" | "this_month" | "custom";
  startDate?: string;
}

export interface DateRangePickerProps {
  label?: string;
  onChange: (value: DateRangeValue) => void;
  value: DateRangeValue;
}

const dateRangeOptions: readonly SelectOption[] = [
  { label: "Today", value: "today" },
  { label: "7 days", value: "seven_days" },
  { label: "30 days", value: "thirty_days" },
  { label: "This month", value: "this_month" },
  { label: "Custom", value: "custom" }
] as const;

export function DateRangePicker({
  label = "Date range",
  onChange,
  value
}: DateRangePickerProps) {
  return (
    <div className="flex min-w-[220px] flex-col gap-2 text-sm">
      <span className="font-medium text-text-secondary">{label}</span>
      <div className="space-y-2">
        <Select
          onValueChange={(nextPreset) =>
            onChange({
              endDate: value.endDate,
              preset: nextPreset as DateRangeValue["preset"],
              startDate: value.startDate
            })
          }
          options={dateRangeOptions}
          value={value.preset}
        />
        {value.preset === "custom" ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              onChange={(event) =>
                onChange({
                  ...value,
                  startDate: event.target.value
                })
              }
              type="date"
              value={value.startDate ?? ""}
            />
            <Input
              onChange={(event) =>
                onChange({
                  ...value,
                  endDate: event.target.value
                })
              }
              type="date"
              value={value.endDate ?? ""}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface FilterBarProps {
  filters?: UpToThree<React.ReactNode>;
  onReset?: () => void;
  onSearchChange?: (value: string) => void;
  placeholder?: string;
  searchValue?: string;
}

export function FilterBar({
  filters = [],
  onReset,
  onSearchChange,
  placeholder = "Search",
  searchValue = ""
}: FilterBarProps) {
  const [draftValue, setDraftValue] = React.useState(searchValue);

  React.useEffect(() => {
    setDraftValue(searchValue);
  }, [searchValue]);

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (draftValue !== searchValue) {
        onSearchChange?.(draftValue);
      }
    }, 300);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [draftValue, onSearchChange, searchValue]);

  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-softer">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <label className="relative w-full xl:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <input
            className="h-11 w-full rounded-input border border-border bg-surface pl-10 pr-3 text-sm text-text shadow-softer outline-none transition placeholder:text-text-muted focus:border-brand/30 focus:ring-4 focus:ring-brand/10"
            onChange={(event) => {
              setDraftValue(event.target.value);
            }}
            placeholder={placeholder}
            value={draftValue}
          />
        </label>
        <div className="flex flex-1 flex-col gap-3 xl:flex-row xl:items-end xl:justify-end">
          {filters.map((filter, index) => (
            <div key={index} className="min-w-0">
              {filter}
            </div>
          ))}
          {onReset ? (
            <Button onClick={onReset} variant="ghost">
              Reset
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function StatusBadge({ status }: { status: StatusValue }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        statusBadgeStyles[status]
      )}
    >
      {statusLabelMap[status]}
    </span>
  );
}

export interface MoneyTextProps {
  amountMinor: bigint;
  className?: string;
  currency: CurrencyCode;
  locale?: string;
}

export function MoneyText({
  amountMinor,
  className,
  currency,
  locale = "en-GH"
}: MoneyTextProps) {
  return (
    <span className={cn("font-medium tabular-nums", className)}>
      {formatMoney(amountMinor, currency, locale)}
    </span>
  );
}

interface ToastState {
  description?: string;
  id: string;
  open: boolean;
  title: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastState, "id" | "open">) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }

  return context;
}

function toastVariantStyles(variant: ToastVariant) {
  switch (variant) {
    case "success":
      return "border-success/20 bg-success-soft text-success";
    case "warning":
      return "border-warning/20 bg-warning-soft text-warning";
    case "danger":
      return "border-danger/20 bg-danger-soft text-danger";
    case "info":
    default:
      return "border-info/20 bg-info-soft text-info";
  }
}

export interface ToastProps {
  description?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  variant?: ToastVariant;
}

export function Toast({
  description,
  onOpenChange,
  open,
  title,
  variant = "info"
}: ToastProps) {
  return (
    <RadixToast.Root
      className={cn(
        "grid min-w-[280px] gap-1 rounded-card border px-4 py-3 shadow-soft",
        toastVariantStyles(variant)
      )}
      onOpenChange={onOpenChange}
      open={open}
    >
      <RadixToast.Title className="text-sm font-semibold">{title}</RadixToast.Title>
      {description ? (
        <RadixToast.Description className="text-sm opacity-90">
          {description}
        </RadixToast.Description>
      ) : null}
    </RadixToast.Root>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);

  const pushToast = React.useCallback(
    ({ description, title, variant }: Omit<ToastState, "id" | "open">) => {
      const id = crypto.randomUUID();
      setToasts((current) => [
        ...current,
        {
          description,
          id,
          open: true,
          title,
          variant
        }
      ]);
    },
    []
  );

  return (
    <ToastContext.Provider value={{ pushToast }}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            description={toast.description}
            onOpenChange={(open) => {
              setToasts((current) =>
                current
                  .map((item) => (item.id === toast.id ? { ...item, open } : item))
                  .filter((item) => item.open)
              );
            }}
            open={toast.open}
            title={toast.title}
            variant={toast.variant}
          />
        ))}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[70] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-3 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export interface CopyFieldProps {
  label?: string;
  value: string;
}

export function CopyField({ label, value }: CopyFieldProps) {
  const { pushToast } = useToast();

  return (
    <div className="flex flex-col gap-2">
      {label ? <span className="text-sm font-medium text-text-secondary">{label}</span> : null}
      <div className="flex items-center gap-2 rounded-input border border-border bg-surface px-3 py-2 shadow-softer">
        <code className="min-w-0 flex-1 truncate text-sm text-text">{value}</code>
        <Tooltip content="Copy value">
          <Button
            className="h-9 px-3"
            onClick={async () => {
              await navigator.clipboard.writeText(value);
              pushToast({
                title: "Copied to clipboard",
                description: value,
                variant: "success"
              });
            }}
            variant="ghost"
          >
            <Copy className="size-4" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

interface BaseLayerProps {
  children: React.ReactNode;
  description?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  title: string;
  trigger?: React.ReactNode;
}

function dialogFrame({
  children,
  className
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-6 shadow-soft",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Modal({
  children,
  description,
  onOpenChange,
  open,
  title,
  trigger
}: BaseLayerProps) {
  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text/30 backdrop-blur-sm" />
        <Dialog.Content asChild>
          {dialogFrame({
            children: (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Dialog.Title className="text-lg font-semibold text-text">
                      {title}
                    </Dialog.Title>
                    {description ? (
                      <Dialog.Description className="mt-1 text-sm text-text-secondary">
                        {description}
                      </Dialog.Description>
                    ) : null}
                  </div>
                  <Dialog.Close asChild>
                    <Button className="h-9 px-3" variant="ghost">
                      <X className="size-4" />
                    </Button>
                  </Dialog.Close>
                </div>
                {children}
              </div>
            )
          })}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Drawer({
  children,
  description,
  onOpenChange,
  open,
  title,
  trigger
}: BaseLayerProps) {
  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text/20 backdrop-blur-sm" />
        <Dialog.Content className="fixed right-0 top-0 z-50 h-full w-full max-w-xl overflow-y-auto border-l border-border bg-surface p-6 shadow-soft focus:outline-none">
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold text-text">
                  {title}
                </Dialog.Title>
                {description ? (
                  <Dialog.Description className="mt-1 text-sm text-text-secondary">
                    {description}
                  </Dialog.Description>
                ) : null}
              </div>
              <Dialog.Close asChild>
                <Button className="h-9 px-3" variant="ghost">
                  <X className="size-4" />
                </Button>
              </Dialog.Close>
            </div>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface ConfirmDialogProps extends BaseLayerProps {
  confirmLabel?: string;
  onConfirm: (reason?: string) => Promise<void> | void;
  reasonLabel?: string;
  requireReason?: boolean;
}

export function ConfirmDialog({
  children,
  confirmLabel = "Confirm",
  description,
  onConfirm,
  onOpenChange,
  open,
  reasonLabel = "Reason",
  requireReason = false,
  title,
  trigger
}: ConfirmDialogProps) {
  const [reason, setReason] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  return (
    <Modal
      description={description}
      onOpenChange={onOpenChange}
      open={open}
      title={title}
      trigger={trigger}
    >
      <div className="space-y-4">
        {children}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-secondary">
            {reasonLabel}
          </label>
          <textarea
            className="min-h-28 w-full rounded-input border border-border bg-surface px-3 py-2.5 text-sm text-text shadow-softer outline-none transition placeholder:text-text-muted focus:border-brand/30 focus:ring-4 focus:ring-brand/10"
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder={
              requireReason ? "A reason is required for this action." : "Add context if needed."
            }
            value={reason}
          />
        </div>
        <div className="flex justify-end gap-3">
          <Button
            loading={loading}
            onClick={async () => {
              if (requireReason && reason.trim() === "") {
                return;
              }

              setLoading(true);
              await onConfirm(reason.trim() || undefined);
              setLoading(false);
            }}
            variant="danger"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface SidebarItem {
  href: string;
  icon?: React.ReactNode;
  label: string;
}

export interface AppShellProps {
  activePath: string;
  children: React.ReactNode;
  mode: PageMode;
  navItems: readonly SidebarItem[];
  onModeChange: (mode: PageMode) => void;
  title: string;
  topBarContent?: React.ReactNode;
}

export function AppShell({
  activePath,
  children,
  mode,
  navItems,
  onModeChange,
  title,
  topBarContent
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <div className="min-h-screen bg-surface-subtle text-text">
      {mode === "test" ? (
        <div className="border-b border-brand-200 bg-brand-50 px-4 py-2 text-center text-xs font-medium text-brand md:px-6">
          Test mode - no real money moves
        </div>
      ) : null}
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-border bg-surface px-4 py-5 transition md:sticky",
            collapsed ? "md:w-24" : "md:w-72",
            sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
          )}
        >
          <div className="flex items-center justify-between">
            <div className={cn("min-w-0", collapsed && "md:hidden")}>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-text-muted">
                RichesPay
              </p>
              <h2 className="mt-1 text-lg font-semibold text-text">{title}</h2>
            </div>
            <Button
              className="h-9 px-3"
              onClick={() => {
                setCollapsed((current) => !current);
              }}
              variant="ghost"
            >
              <PanelLeft className="size-4" />
            </Button>
          </div>
          <nav className="mt-8 space-y-1">
            {navItems.map((item) => {
              const active = item.href === activePath;
              return (
                <a
                  key={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-input px-3 py-2.5 text-sm font-medium transition",
                    active
                      ? "bg-brand-50 text-brand"
                      : "text-text-secondary hover:bg-surface-subtle hover:text-text"
                  )}
                  href={item.href}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className={cn(collapsed && "md:hidden")}>{item.label}</span>
                </a>
              );
            })}
          </nav>
          <div className="mt-auto rounded-card border border-border bg-surface-subtle p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
                  Mode
                </p>
                <p className="mt-1 text-sm font-medium text-text">
                  {mode === "test" ? "Test" : "Live"}
                </p>
              </div>
              <Switch.Root
                checked={mode === "live"}
                className="relative h-7 w-12 rounded-full bg-brand-100 outline-none transition data-[state=checked]:bg-brand"
                onCheckedChange={(checked) => {
                  onModeChange(checked ? "live" : "test");
                }}
              >
                <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-white shadow-sm transition will-change-transform data-[state=checked]:translate-x-6" />
              </Switch.Root>
            </div>
          </div>
        </aside>
        <div className="flex min-h-screen flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
            <div className="flex items-center justify-between gap-4 px-4 py-4 md:px-6">
              <div className="flex items-center gap-3">
                <Button
                  className="h-10 px-3 md:hidden"
                  onClick={() => {
                    setSidebarOpen((current) => !current);
                  }}
                  variant="ghost"
                >
                  <Menu className="size-4" />
                </Button>
                <div>
                  <p className="text-sm font-medium text-text">{title}</p>
                  <p className="text-xs text-text-secondary">Merchant dashboard</p>
                </div>
              </div>
              <div>{topBarContent}</div>
            </div>
          </header>
          <main className="flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
        </div>
      </div>
      {sidebarOpen ? (
        <button
          aria-label="Close sidebar"
          className="fixed inset-0 z-20 bg-text/20 md:hidden"
          onClick={() => {
            setSidebarOpen(false);
          }}
          type="button"
        />
      ) : null}
    </div>
  );
}

export interface DataTablePageInfo {
  endCursor?: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  limit: number;
  startCursor?: string;
}

export interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  emptyState?: React.ReactNode;
  loading?: boolean;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
  onRowClick?: (row: TData) => void;
  pageInfo: DataTablePageInfo;
  rowId?: (row: TData, index: number) => string;
  skeletonRows?: number;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  emptyState,
  loading = false,
  onNextPage,
  onPreviousPage,
  onRowClick,
  pageInfo,
  rowId,
  skeletonRows = 8,
  sorting = [],
  onSortingChange
}: DataTableProps<TData>) {
  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
    getRowId: rowId,
    manualPagination: true,
    manualSorting: true,
    onSortingChange: (updater) => {
      if (!onSortingChange) {
        return;
      }

      const nextValue =
        typeof updater === "function" ? updater(sorting) : updater;
      onSortingChange(nextValue);
    },
    state: {
      sorting
    }
  });

  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface shadow-softer">
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-10 bg-surface">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const sortDirection = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="border-b border-border px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] text-text-muted"
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          className="inline-flex items-center gap-2"
                          onClick={header.column.getToggleSortingHandler()}
                          type="button"
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          <ChevronsUpDown
                            className={cn(
                              "size-4 text-text-muted",
                              sortDirection && "text-brand"
                            )}
                          />
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }).map((_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`}>
                    {columns.map((_, cellIndex) => (
                      <td
                        key={`skeleton-${rowIndex}-${cellIndex}`}
                        className="border-b border-border px-4 py-4"
                      >
                        <SkeletonBlock className="h-4 w-full max-w-[140px]" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      "transition hover:bg-surface-subtle",
                      onRowClick && "cursor-pointer"
                    )}
                    onClick={() => {
                      onRowClick?.(row.original);
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="border-b border-border px-4 py-4 text-sm text-text"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && data.length === 0 ? (
        <div className="p-6">
          {emptyState ?? (
            <EmptyState
              description="Try widening your filters or running a new search."
              title="No results found"
            />
          )}
        </div>
      ) : null}
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm text-text-secondary sm:flex-row sm:items-center sm:justify-between">
        <p>
          Showing up to {pageInfo.limit} rows per page
          {pageInfo.startCursor ? `, from ${pageInfo.startCursor}` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={!pageInfo.hasPreviousPage}
            onClick={onPreviousPage}
            variant="ghost"
          >
            <ChevronLeft className="size-4" />
            Previous
          </Button>
          <Button disabled={!pageInfo.hasNextPage} onClick={onNextPage} variant="ghost">
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

export type {
  ColumnDef,
  SortingState
};
