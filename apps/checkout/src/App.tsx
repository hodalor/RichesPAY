import * as React from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import {
  createBrowserRouter,
  RouterProvider,
  useParams,
  useSearchParams
} from "react-router-dom";

import type { CurrencyCode } from "@richespay/shared";
import { Button, EmptyState, Input } from "@richespay/ui";

import { ApiError, apiRequest } from "./api-client";

type CheckoutMethod = "mobile_money" | "card";
type CheckoutSessionStatus = "open" | "completed" | "expired";
type PaymentLinkAmountMode = "fixed" | "customer_entered";
type CheckoutViewState =
  | "form"
  | "card_action"
  | "waiting"
  | "success"
  | "failure"
  | "expired";

interface CheckoutCardDetails {
  brand: string | null;
  expiry_month: number | null;
  expiry_year: number | null;
  last4: string | null;
}

interface CheckoutNextAction {
  iframe_url?: string;
  type: "hosted_fields" | "redirect_url";
  url?: string;
}

interface CheckoutSessionData {
  allowed_methods: CheckoutMethod[];
  amount: number;
  amount_formatted: string;
  cancel_url: string | null;
  collection: {
    card: CheckoutCardDetails | null;
    failure_code: string | null;
    failure_message: string | null;
    id: string;
    method: CheckoutMethod;
    next_action: CheckoutNextAction | null;
    provider_ref: string | null;
    status: string;
  } | null;
  currency: CurrencyCode;
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

interface PaymentLinkPublicData {
  active: boolean;
  amount: number | null;
  amount_formatted: string | null;
  amount_mode: PaymentLinkAmountMode;
  currency: CurrencyCode;
  description: string | null;
  merchant: {
    display_name: string;
  };
  reusable: boolean;
  slug: string;
  title: string;
}

interface PaymentSubmissionInput {
  amount?: number;
  customerEmail?: string;
  customerName?: string;
  method: CheckoutMethod;
  network?: string;
  phone?: string;
}

interface SimulatorCardPayload {
  callbackUrl: string | null;
  cancelUrl: string | null;
  collectionId: string;
  currency: string;
  providerRef: string;
  returnUrl: string | null;
}

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    path: "/",
    element: <CheckoutHome />
  },
  {
    path: "/session/:sessionId",
    element: <HostedCheckoutPage />
  },
  {
    path: "/link/:slug",
    element: <PaymentLinkCheckoutPage />
  },
  {
    path: "/simulator/card-fields",
    element: <SimulatorCardFieldsPage />
  }
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

function CheckoutHome() {
  return (
    <PageFrame>
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-8">
        <div className="w-full max-w-xl rounded-card border border-border bg-white p-8 shadow-softer">
          <EmptyState
            description="Open a hosted checkout session or payment link URL from your merchant app."
            title="Checkout link required"
          />
        </div>
      </main>
    </PageFrame>
  );
}

function HostedCheckoutPage() {
  const { sessionId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("key");

  const sessionQuery = useQuery({
    queryKey: ["checkout-session", sessionId, token],
    queryFn: () =>
      apiRequest<CheckoutSessionData>(`/v1/checkout/sessions/${sessionId}`, {
        bearerToken: token
      }),
    enabled: sessionId.length > 0 && Boolean(token),
    refetchInterval: (query) =>
      shouldPollCheckoutSession(query.state.data as CheckoutSessionData | undefined)
        ? 3000
        : false
  });

  if (!token) {
    return (
      <CenteredStatusCard
        description="This hosted checkout URL is missing its public key."
        title="Checkout unavailable"
      />
    );
  }

  return (
    <CheckoutScreen
      error={sessionQuery.error}
      link={undefined}
      loadLabel="Loading checkout session"
      onRefresh={sessionQuery.refetch}
      onSubmitPayment={async (input) =>
        apiRequest<CheckoutSessionData>(`/v1/checkout/sessions/${sessionId}/pay`, {
          bearerToken: token,
          body: {
            method: input.method,
            ...(input.network ? { network: input.network } : {}),
            ...(input.phone ? { phone: input.phone } : {})
          },
          idempotencyKey: createIdempotencyKey(),
          method: "POST"
        })
      }
      session={sessionQuery.data}
      sessionLoading={sessionQuery.isLoading}
    />
  );
}

function PaymentLinkCheckoutPage() {
  const { slug = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const queryClient = useQueryClient();

  const paymentLinkQuery = useQuery({
    queryKey: ["payment-link", slug],
    queryFn: () => apiRequest<PaymentLinkPublicData>(`/v1/checkout/payment-links/${slug}`),
    enabled: slug.length > 0
  });

  const sessionQuery = useQuery({
    queryKey: ["payment-link-session", slug, sessionId],
    queryFn: () =>
      apiRequest<CheckoutSessionData>(
        `/v1/checkout/payment-links/${slug}/sessions/${sessionId}`
      ),
    enabled: slug.length > 0 && Boolean(sessionId),
    refetchInterval: (query) =>
      shouldPollCheckoutSession(query.state.data as CheckoutSessionData | undefined)
        ? 3000
        : false
  });

  return (
    <CheckoutScreen
      error={sessionQuery.error ?? paymentLinkQuery.error}
      link={paymentLinkQuery.data}
      loadLabel="Loading payment link"
      onRefresh={async () => {
        await Promise.all([paymentLinkQuery.refetch(), sessionQuery.refetch()]);
      }}
      onSubmitPayment={async (input) => {
        let effectiveSessionId = sessionId;

        if (!effectiveSessionId) {
          const created = await apiRequest<{ id: string; url: string }>(
            `/v1/checkout/payment-links/${slug}/sessions`,
            {
              body: {
                ...(input.amount ? { amount: input.amount } : {}),
                customer: {
                  ...(input.customerEmail ? { email: input.customerEmail } : {}),
                  ...(input.customerName ? { name: input.customerName } : {})
                }
              },
              method: "POST"
            }
          );

          effectiveSessionId = created.id;
          const nextParams = new URLSearchParams(searchParams);
          nextParams.set("session_id", created.id);
          setSearchParams(nextParams, { replace: true });
        }

        const updatedSession = await apiRequest<CheckoutSessionData>(
          `/v1/checkout/payment-links/${slug}/sessions/${effectiveSessionId}/pay`,
          {
            body: {
              method: input.method,
              ...(input.network ? { network: input.network } : {}),
              ...(input.phone ? { phone: input.phone } : {})
            },
            idempotencyKey: createIdempotencyKey(),
            method: "POST"
          }
        );

        queryClient.setQueryData(
          ["payment-link-session", slug, effectiveSessionId],
          updatedSession
        );

        return updatedSession;
      }}
      session={sessionQuery.data}
      sessionLoading={
        paymentLinkQuery.isLoading || (Boolean(sessionId) && sessionQuery.isLoading)
      }
    />
  );
}

function CheckoutScreen({
  error,
  link,
  loadLabel,
  onRefresh,
  onSubmitPayment,
  session,
  sessionLoading
}: {
  error: unknown;
  link: PaymentLinkPublicData | undefined;
  loadLabel: string;
  onRefresh: () => Promise<unknown> | unknown;
  onSubmitPayment: (input: PaymentSubmissionInput) => Promise<CheckoutSessionData>;
  session: CheckoutSessionData | undefined;
  sessionLoading: boolean;
}) {
  const [selectedMethod, setSelectedMethod] = React.useState<CheckoutMethod>("mobile_money");
  const [selectedNetwork, setSelectedNetwork] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [amountInput, setAmountInput] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const postedEventRef = React.useRef<string | null>(null);
  const redirectedActionRef = React.useRef<string | null>(null);

  const paymentMutation = useMutation({
    mutationFn: onSubmitPayment
  });

  React.useEffect(() => {
    if (session?.customer.email) {
      setCustomerEmail(session.customer.email);
    }

    if (session?.customer.name) {
      setCustomerName(session.customer.name);
    }
  }, [session?.customer.email, session?.customer.name]);

  React.useEffect(() => {
    const preferredMethod =
      session?.collection?.method ??
      (session?.allowed_methods.includes("mobile_money")
        ? "mobile_money"
        : session?.allowed_methods[0] ?? "mobile_money");

    setSelectedMethod(preferredMethod);
  }, [session?.allowed_methods, session?.collection?.method]);

  const effectiveSession = paymentMutation.data ?? session;
  const activeCollection = effectiveSession?.collection ?? null;
  const checkoutState = getCheckoutViewState(effectiveSession);
  const merchantName =
    effectiveSession?.merchant.display_name ??
    link?.merchant.display_name ??
    "RichesPay Merchant";
  const amountDisplay =
    effectiveSession?.amount_formatted ??
    link?.amount_formatted ??
    (link?.amount_mode === "customer_entered" ? "Customer enters amount" : null);
  const currency = effectiveSession?.currency ?? link?.currency ?? "GHS";
  const networks = getNetworkOptions(currency);
  const amountRequired = !effectiveSession && link?.amount_mode === "customer_entered";
  const cardAction =
    activeCollection?.method === "card" ? activeCollection.next_action : null;
  const redirectUrl =
    checkoutState === "card_action" && cardAction?.type === "redirect_url"
      ? cardAction.url ?? null
      : null;

  React.useEffect(() => {
    if (!effectiveSession) {
      return;
    }

    if (
      checkoutState === "success" &&
      postedEventRef.current !== `success:${effectiveSession.id}`
    ) {
      postedEventRef.current = `success:${effectiveSession.id}`;
      postCheckoutEvent({
        collection_id: effectiveSession.collection?.id ?? null,
        reference: effectiveSession.reference,
        session_id: effectiveSession.id,
        source: "richespay-checkout",
        status: effectiveSession.collection?.status ?? null,
        type: "checkout.success"
      });
    }

    if (
      checkoutState === "failure" &&
      postedEventRef.current !== `failure:${effectiveSession.id}`
    ) {
      postedEventRef.current = `failure:${effectiveSession.id}`;
      postCheckoutEvent({
        collection_id: effectiveSession.collection?.id ?? null,
        reference: effectiveSession.reference,
        session_id: effectiveSession.id,
        source: "richespay-checkout",
        status: effectiveSession.collection?.status ?? null,
        type: "checkout.failed"
      });
    }
  }, [checkoutState, effectiveSession]);

  React.useEffect(() => {
    if (!redirectUrl || redirectedActionRef.current === redirectUrl) {
      return;
    }

    redirectedActionRef.current = redirectUrl;
    window.location.assign(redirectUrl);
  }, [redirectUrl]);

  const submissionError = paymentMutation.error;
  const displayError = error ?? submissionError;

  if (sessionLoading && !effectiveSession && !link) {
    return <CenteredStatusCard description={loadLabel} title="Please wait" />;
  }

  if (displayError && !effectiveSession && !link) {
    return (
      <CenteredStatusCard
        action={
          <Button onClick={() => void onRefresh()} variant="secondary">
            Try again
          </Button>
        }
        description={getErrorMessage(displayError)}
        title="We couldn't load this checkout"
      />
    );
  }

  return (
    <PageFrame>
      <main className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-8">
        <div className="grid w-full max-w-5xl gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="hidden flex-col justify-between rounded-[28px] bg-brand-50/70 p-8 text-slate-900 shadow-softer lg:flex">
            <div>
              <div className="inline-flex items-center gap-3 rounded-full border border-brand-100 bg-white px-4 py-2 text-sm font-medium text-brand shadow-softer">
                <span className="inline-flex size-2.5 rounded-full bg-brand" />
                Secure checkout
              </div>
              <h1 className="mt-8 text-4xl font-semibold tracking-tight text-slate-950">
                Mobile money and card payments, finished in one calm flow.
              </h1>
              <p className="mt-4 max-w-md text-base text-slate-600">
                Choose your method, complete the provider step, and we keep the status
                in sync automatically until the merchant has a final answer.
              </p>
            </div>

            <div className="rounded-card border border-white/80 bg-white/90 p-5 shadow-softer">
              <p className="text-sm font-medium text-slate-500">What to expect</p>
              <ol className="mt-4 space-y-3 text-sm text-slate-700">
                <li>1. Choose mobile money or card.</li>
                <li>2. Enter only the details required for that method.</li>
                <li>3. Complete the provider approval and return automatically.</li>
              </ol>
            </div>
          </div>

          <section className="rounded-[28px] border border-border bg-white p-6 shadow-softer sm:p-8">
            <header className="text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-xl font-semibold text-brand">
                {merchantName.slice(0, 1).toUpperCase()}
              </div>
              <p className="mt-4 text-sm font-medium uppercase tracking-[0.18em] text-slate-400">
                {merchantName}
              </p>
              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                {amountDisplay ?? "Checkout"}
              </h2>
              <p className="mt-3 text-sm text-slate-500">
                {effectiveSession?.description ??
                  link?.description ??
                  "Complete your payment securely with RichesPay."}
              </p>
            </header>

            {displayError ? (
              <div className="mt-6 rounded-2xl border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger">
                {getErrorMessage(displayError)}
              </div>
            ) : null}

            {checkoutState === "success" && effectiveSession ? (
              <ResultPanel
                actionLabel={effectiveSession.success_url ? "Return to merchant" : "Done"}
                card={effectiveSession.collection?.card ?? null}
                description="Your payment was successful. You can head back to the merchant now."
                method={effectiveSession.collection?.method ?? selectedMethod}
                onAction={() => handleReturnTarget(effectiveSession.success_url)}
                title="Payment complete"
                tone="success"
              />
            ) : checkoutState === "failure" && effectiveSession ? (
              <ResultPanel
                actionLabel={effectiveSession.cancel_url ? "Return to merchant" : "Try again"}
                card={effectiveSession.collection?.card ?? null}
                description={
                  effectiveSession.collection?.failure_message ??
                  "The payment did not go through. You can retry or return to the merchant."
                }
                method={effectiveSession.collection?.method ?? selectedMethod}
                onAction={() => handleReturnTarget(effectiveSession.cancel_url)}
                title="Payment failed"
                tone="danger"
              />
            ) : checkoutState === "expired" ? (
              <ResultPanel
                actionLabel="Refresh link"
                card={null}
                description="This checkout session has expired. Open the payment link again to start a fresh session."
                method={selectedMethod}
                onAction={() => window.location.reload()}
                title="Session expired"
                tone="neutral"
              />
            ) : checkoutState === "card_action" && effectiveSession && cardAction ? (
              <CardActionPanel action={cardAction} session={effectiveSession} />
            ) : checkoutState === "waiting" && effectiveSession ? (
              <WaitingPanel session={effectiveSession} />
            ) : (
              <div className="mt-8">
                <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface-subtle p-1.5">
                  {renderMethodTab({
                    active: selectedMethod === "mobile_money",
                    disabled: !(effectiveSession?.allowed_methods.includes("mobile_money") ?? true),
                    label: "Mobile money",
                    onClick: () => setSelectedMethod("mobile_money")
                  })}
                  {renderMethodTab({
                    active: selectedMethod === "card",
                    disabled: !(effectiveSession?.allowed_methods.includes("card") ?? true),
                    label: "Card",
                    onClick: () => setSelectedMethod("card")
                  })}
                </div>

                {selectedMethod === "card" ? (
                  <form
                    className="mt-6 space-y-5"
                    onSubmit={(event) => {
                      event.preventDefault();

                      const amount = amountRequired ? Number(amountInput) : undefined;
                      void paymentMutation.mutate({
                        ...(amount ? { amount } : {}),
                        ...(customerEmail.trim()
                          ? { customerEmail: customerEmail.trim() }
                          : {}),
                        ...(customerName.trim()
                          ? { customerName: customerName.trim() }
                          : {}),
                        method: "card"
                      });
                    }}
                  >
                    <div className="rounded-3xl border border-border bg-surface-subtle p-5">
                      <h3 className="text-lg font-semibold text-slate-950">
                        Secure card entry
                      </h3>
                      <p className="mt-2 text-sm text-slate-600">
                        Your card details are collected only on the acquirer page. RichesPay
                        never receives card numbers or CVV from this checkout flow.
                      </p>
                    </div>

                    {amountRequired ? (
                      <Input
                        label={`Amount (${currency})`}
                        min="1"
                        onChange={(event) => setAmountInput(event.target.value)}
                        placeholder="Enter amount in minor units"
                        required
                        type="number"
                        value={amountInput}
                      />
                    ) : null}

                    {!effectiveSession ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Input
                          label="Customer name"
                          onChange={(event) => setCustomerName(event.target.value)}
                          placeholder="Optional"
                          value={customerName}
                        />
                        <Input
                          label="Customer email"
                          onChange={(event) => setCustomerEmail(event.target.value)}
                          placeholder="Optional"
                          type="email"
                          value={customerEmail}
                        />
                      </div>
                    ) : null}

                    <Button
                      className="h-12 w-full"
                      disabled={amountRequired && !Number.isFinite(Number(amountInput))}
                      loading={paymentMutation.isPending}
                      type="submit"
                      variant="primary"
                    >
                      Continue to secure card page
                    </Button>
                  </form>
                ) : (
                  <form
                    className="mt-6 space-y-5"
                    onSubmit={(event) => {
                      event.preventDefault();

                      if (selectedNetwork.trim() === "" || phone.trim() === "") {
                        return;
                      }

                      const amount = amountRequired ? Number(amountInput) : undefined;
                      void paymentMutation.mutate({
                        ...(amount ? { amount } : {}),
                        ...(customerEmail.trim()
                          ? { customerEmail: customerEmail.trim() }
                          : {}),
                        ...(customerName.trim()
                          ? { customerName: customerName.trim() }
                          : {}),
                        method: "mobile_money",
                        network: selectedNetwork,
                        phone: phone.trim()
                      });
                    }}
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-600">Choose network</p>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {networks.map((network) => (
                          <button
                            key={network.value}
                            className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                              selectedNetwork === network.value
                                ? "border-brand bg-brand-50 text-brand"
                                : "border-border bg-white text-slate-700 hover:border-brand/30 hover:bg-brand-50/40"
                            }`}
                            onClick={() => setSelectedNetwork(network.value)}
                            type="button"
                          >
                            <span
                              className="inline-flex size-10 items-center justify-center rounded-xl text-sm font-semibold text-white"
                              style={{ backgroundColor: network.color }}
                            >
                              {network.shortLabel}
                            </span>
                            <span className="text-sm font-medium">{network.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {amountRequired ? (
                      <Input
                        label={`Amount (${currency})`}
                        min="1"
                        onChange={(event) => setAmountInput(event.target.value)}
                        placeholder="Enter amount in minor units"
                        required
                        type="number"
                        value={amountInput}
                      />
                    ) : null}

                    {!effectiveSession ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Input
                          label="Customer name"
                          onChange={(event) => setCustomerName(event.target.value)}
                          placeholder="Optional"
                          value={customerName}
                        />
                        <Input
                          label="Customer email"
                          onChange={(event) => setCustomerEmail(event.target.value)}
                          placeholder="Optional"
                          type="email"
                          value={customerEmail}
                        />
                      </div>
                    ) : null}

                    <Input
                      label="Mobile number"
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="+233241230001"
                      required
                      type="tel"
                      value={phone}
                    />

                    <Button
                      className="h-12 w-full"
                      disabled={selectedNetwork.trim() === "" || phone.trim() === ""}
                      loading={paymentMutation.isPending}
                      type="submit"
                      variant="primary"
                    >
                      Pay now
                    </Button>
                  </form>
                )}
              </div>
            )}

            <footer className="mt-8 flex items-center justify-center gap-2 text-xs font-medium text-slate-400">
              <span className="inline-flex size-2.5 rounded-full bg-brand" />
              Secured by RichesPay
            </footer>
          </section>
        </div>
      </main>
    </PageFrame>
  );
}

function CardActionPanel({
  action,
  session
}: {
  action: CheckoutNextAction;
  session: CheckoutSessionData;
}) {
  if (action.type === "redirect_url" && action.url) {
    return (
      <div className="mt-8 rounded-3xl border border-brand/10 bg-brand-50/60 p-6 text-center">
        <h3 className="text-2xl font-semibold text-slate-950">
          Redirecting to your secure card page
        </h3>
        <p className="mt-3 text-sm text-slate-600">
          Your bank or card acquirer handles card entry and 3-D Secure on their own
          page. If the redirect does not start, use the button below.
        </p>
        <Button
          className="mt-6 h-12 w-full"
          onClick={() => {
            if (action.url) {
              window.location.assign(action.url);
            }
          }}
          variant="primary"
        >
          Open secure card page
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-5">
      <div className="rounded-3xl border border-brand/10 bg-brand-50/60 p-6">
        <h3 className="text-2xl font-semibold text-slate-950">
          Complete your card payment
        </h3>
        <p className="mt-3 text-sm text-slate-600">
          This secure frame is provided by the acquirer. RichesPay never receives your
          full card number or CVV.
        </p>
      </div>

      <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-softer">
        <iframe
          allow="payment *"
          className="min-h-[560px] w-full border-0"
          sandbox="allow-forms allow-scripts allow-same-origin"
          src={action.iframe_url}
          title={`Secure card entry for ${session.merchant.display_name}`}
        />
      </div>

      <div className="rounded-2xl border border-border bg-surface-subtle p-4 text-sm text-slate-600">
        We keep checking the payment status automatically while you complete the
        secure card step.
      </div>
    </div>
  );
}

function WaitingPanel({ session }: { session: CheckoutSessionData }) {
  const expiresAt = new Date(session.expires_at);
  const secondsRemaining = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  const method = session.collection?.method ?? "mobile_money";

  return (
    <div className="mt-8 rounded-3xl border border-brand/10 bg-brand-50/60 p-6 text-center">
      <div className="mx-auto flex size-16 animate-pulse items-center justify-center rounded-full bg-white text-brand shadow-softer">
        <span className="size-4 rounded-full bg-brand" />
      </div>
      <h3 className="mt-5 text-2xl font-semibold text-slate-950">
        {method === "card"
          ? "Waiting for card authorisation"
          : "Approve the prompt on your phone"}
      </h3>
      <p className="mt-3 text-sm text-slate-600">
        We’re checking the payment status every 3 seconds. This screen updates
        automatically as soon as the provider responds.
      </p>
      <div className="mt-6 rounded-2xl border border-white bg-white/80 p-4 text-left shadow-softer">
        <dl className="space-y-3 text-sm text-slate-600">
          <div className="flex items-center justify-between gap-4">
            <dt>Method</dt>
            <dd className="font-medium text-slate-900">{formatMethodLabel(method)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt>Status</dt>
            <dd className="font-medium capitalize text-slate-900">
              {session.collection?.status ?? "pending"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt>Amount</dt>
            <dd className="font-medium text-slate-900">{session.amount_formatted}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt>Time remaining</dt>
            <dd className="font-medium text-slate-900">
              {formatCountdown(secondsRemaining)}
            </dd>
          </div>
        </dl>
      </div>
      <CardSummary card={session.collection?.card ?? null} />
    </div>
  );
}

function ResultPanel({
  actionLabel,
  card,
  description,
  method,
  onAction,
  title,
  tone
}: {
  actionLabel: string;
  card: CheckoutCardDetails | null;
  description: string;
  method: CheckoutMethod;
  onAction: () => void;
  title: string;
  tone: "success" | "danger" | "neutral";
}) {
  const toneClasses =
    tone === "success"
      ? "border-success/15 bg-success-soft text-success"
      : tone === "danger"
        ? "border-danger/15 bg-danger-soft text-danger"
        : "border-border bg-surface-subtle text-slate-700";

  return (
    <div className={`mt-8 rounded-3xl border p-6 text-center ${toneClasses}`}>
      <h3 className="text-2xl font-semibold text-slate-950">{title}</h3>
      <p className="mt-3 text-sm text-slate-600">{description}</p>
      <div className="mt-4 text-sm font-medium text-slate-700">
        Paid with {formatMethodLabel(method)}
      </div>
      <CardSummary card={card} />
      <Button className="mt-6 h-12 w-full" onClick={onAction} variant="primary">
        {actionLabel}
      </Button>
    </div>
  );
}

function SimulatorCardFieldsPage() {
  const [searchParams] = useSearchParams();
  const callbackUrl = emptyToNull(searchParams.get("callback_url"));
  const cancelUrl = emptyToNull(searchParams.get("cancel_url"));
  const collectionId = searchParams.get("collection_id") ?? "";
  const currency = searchParams.get("currency") ?? "GHS";
  const providerRef = searchParams.get("provider_ref") ?? "sim_card_unknown";
  const returnUrl = emptyToNull(searchParams.get("return_url"));

  const [cardholderName, setCardholderName] = React.useState("");
  const [cardNumber, setCardNumber] = React.useState("");
  const [cvv, setCvv] = React.useState("");
  const [expiryMonth, setExpiryMonth] = React.useState("");
  const [expiryYear, setExpiryYear] = React.useState("");
  const [screen, setScreen] = React.useState<
    "entry" | "submitting" | "challenge" | "success" | "failure"
  >("entry");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [challengePayload, setChallengePayload] =
    React.useState<SimulatorCardPayload | null>(null);
  const [resultCard, setResultCard] = React.useState<CheckoutCardDetails | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    const sanitizedCardNumber = cardNumber.replace(/\D/g, "");
    const normalizedMonth = Number.parseInt(expiryMonth, 10);
    const normalizedYear = normalizeExpiryYear(expiryYear);

    if (collectionId.length === 0) {
      setErrorMessage("This simulator page is missing the collection reference.");
      return;
    }

    if (sanitizedCardNumber.length < 16) {
      setErrorMessage("Use a 16-digit test card number.");
      return;
    }

    if (
      !Number.isInteger(normalizedMonth) ||
      normalizedMonth < 1 ||
      normalizedMonth > 12 ||
      normalizedYear === null
    ) {
      setErrorMessage("Enter a valid expiry month and year.");
      return;
    }

    const scenario = getSimulatorCardScenario(sanitizedCardNumber);
    const card = {
      brand: getCardBrand(sanitizedCardNumber),
      expiry_month: normalizedMonth,
      expiry_year: normalizedYear,
      last4: sanitizedCardNumber.slice(-4)
    } satisfies CheckoutCardDetails;

    setResultCard(card);
    setScreen("submitting");

    const payload: SimulatorCardPayload = {
      callbackUrl,
      cancelUrl,
      collectionId,
      currency,
      providerRef,
      returnUrl
    };

    if (scenario === "3ds_challenge") {
      setChallengePayload(payload);
      setScreen("challenge");
      return;
    }

    try {
      await submitSimulatorCardResult({
        card,
        outcome: scenario === "declined" ? "declined" : "succeeded",
        payload
      });
      setScreen(scenario === "declined" ? "failure" : "success");
    } catch (error) {
      setScreen("entry");
      setErrorMessage(getErrorMessage(error));
    }
  };

  const completeChallenge = async () => {
    if (!challengePayload || !resultCard) {
      return;
    }

    setScreen("submitting");

    try {
      await submitSimulatorCardResult({
        card: resultCard,
        outcome: "succeeded",
        payload: challengePayload
      });
      setScreen("success");
    } catch (error) {
      setScreen("challenge");
      setErrorMessage(getErrorMessage(error));
    }
  };

  return (
    <PageFrame>
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-8">
        <section className="w-full max-w-xl rounded-[28px] border border-border bg-white p-6 shadow-softer sm:p-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/15 bg-brand-50 px-3 py-1 text-xs font-medium text-brand">
            Test-only simulator
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
            Secure card entry
          </h1>
          <p className="mt-3 text-sm text-slate-600">
            This page simulates an acquirer-hosted card form. The API callback receives
            only masked card details, never the full PAN or CVV.
          </p>

          <div className="mt-5 rounded-2xl border border-border bg-surface-subtle p-4 text-sm text-slate-600">
            Test cards: `4000...0001` succeeds, `4000...0002` declines, `4000...0003`
            triggers a 3-D Secure challenge.
          </div>

          {errorMessage ? (
            <div className="mt-5 rounded-2xl border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger">
              {errorMessage}
            </div>
          ) : null}

          {screen === "challenge" ? (
            <div className="mt-6 rounded-3xl border border-brand/10 bg-brand-50/60 p-6 text-center">
              <h2 className="text-2xl font-semibold text-slate-950">
                3-D Secure challenge
              </h2>
              <p className="mt-3 text-sm text-slate-600">
                Approve this test challenge to finish the card authorisation.
              </p>
              <CardSummary card={resultCard} />
              <Button
                className="mt-6 h-12 w-full"
                onClick={() => void completeChallenge()}
                variant="primary"
              >
                Approve challenge
              </Button>
            </div>
          ) : screen === "success" ? (
            <div className="mt-6 rounded-3xl border border-success/15 bg-success-soft p-6 text-center">
              <h2 className="text-2xl font-semibold text-slate-950">
                Card authorised
              </h2>
              <p className="mt-3 text-sm text-slate-600">
                The masked card result has been sent back to checkout.
              </p>
              <CardSummary card={resultCard} />
              <Button
                className="mt-6 h-12 w-full"
                onClick={() => handleReturnTarget(returnUrl)}
                variant="primary"
              >
                Back to checkout
              </Button>
            </div>
          ) : screen === "failure" ? (
            <div className="mt-6 rounded-3xl border border-danger/15 bg-danger-soft p-6 text-center">
              <h2 className="text-2xl font-semibold text-slate-950">Card declined</h2>
              <p className="mt-3 text-sm text-slate-600">
                The acquirer returned a declined result for this test card.
              </p>
              <CardSummary card={resultCard} />
              <Button
                className="mt-6 h-12 w-full"
                onClick={() => handleReturnTarget(cancelUrl)}
                variant="primary"
              >
                Return to checkout
              </Button>
            </div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
              <Input
                label="Cardholder name"
                onChange={(event) => setCardholderName(event.target.value)}
                placeholder="Jane Doe"
                value={cardholderName}
              />
              <Input
                label="Card number"
                onChange={(event) => setCardNumber(event.target.value)}
                placeholder="4000 0000 0000 0001"
                required
                value={cardNumber}
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <Input
                  label="Expiry month"
                  max="12"
                  min="1"
                  onChange={(event) => setExpiryMonth(event.target.value)}
                  placeholder="03"
                  required
                  type="number"
                  value={expiryMonth}
                />
                <Input
                  label="Expiry year"
                  onChange={(event) => setExpiryYear(event.target.value)}
                  placeholder="2028"
                  required
                  type="number"
                  value={expiryYear}
                />
                <Input
                  label="CVV"
                  onChange={(event) => setCvv(event.target.value)}
                  placeholder="123"
                  required
                  type="password"
                  value={cvv}
                />
              </div>

              <div className="rounded-2xl border border-border bg-surface-subtle p-4 text-sm text-slate-600">
                CVV and the full card number stay in this page only and are not included in
                the callback payload.
              </div>

              <Button
                className="h-12 w-full"
                loading={screen === "submitting"}
                type="submit"
                variant="primary"
              >
                Pay {currency}
              </Button>
            </form>
          )}
        </section>
      </main>
    </PageFrame>
  );
}

function CardSummary({ card }: { card: CheckoutCardDetails | null }) {
  if (!card?.last4) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-white bg-white/80 p-4 text-left shadow-softer">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
        Card
      </p>
      <div className="mt-2 flex items-center justify-between gap-4 text-sm text-slate-700">
        <span className="font-medium text-slate-950">
          {card.brand ? formatCardBrand(card.brand) : "Card"} ending in {card.last4}
        </span>
        <span>{formatCardExpiry(card)}</span>
      </div>
    </div>
  );
}

function CenteredStatusCard({
  action,
  description,
  title
}: {
  action?: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <PageFrame>
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-8">
        <div className="w-full max-w-xl rounded-card border border-border bg-white p-8 shadow-softer">
          <EmptyState action={action} description={description} title={title} />
        </div>
      </main>
    </PageFrame>
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#f7f7f5]">{children}</div>;
}

function renderMethodTab({
  active,
  disabled,
  label,
  onClick
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`rounded-2xl px-4 py-3 text-sm font-medium transition ${
        active
          ? "bg-white text-brand shadow-softer"
          : "text-slate-500 hover:bg-white/70"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function shouldPollCheckoutSession(session?: CheckoutSessionData) {
  if (!session || session.status !== "open") {
    return false;
  }

  return session.collection?.status === "pending" || session.collection?.status === "processing";
}

function getCheckoutViewState(session?: CheckoutSessionData): CheckoutViewState {
  if (!session) {
    return "form";
  }

  if (session.status === "completed") {
    return "success";
  }

  if (session.status === "expired") {
    return "expired";
  }

  if (session.collection?.status === "failed") {
    return "failure";
  }

  if (
    session.collection?.method === "card" &&
    session.collection?.next_action &&
    session.collection.status === "processing"
  ) {
    return "card_action";
  }

  if (session.collection?.status === "pending" || session.collection?.status === "processing") {
    return "waiting";
  }

  return "form";
}

function handleReturnTarget(target: string | null) {
  if (target) {
    window.location.assign(target);
    return;
  }

  window.location.reload();
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") {
    return `cko_${crypto.randomUUID()}`;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `cko_${hex}`;
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function postCheckoutEvent(payload: {
  collection_id: string | null;
  reference: string | null;
  session_id: string;
  source: "richespay-checkout";
  status: string | null;
  type: "checkout.failed" | "checkout.success";
}) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(payload, "*");
  }

  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(payload, "*");
  }
}

function getNetworkOptions(currency: CurrencyCode) {
  if (currency === "GHS") {
    return [
      { color: "#facc15", label: "MTN MoMo", shortLabel: "MT", value: "mtn" },
      { color: "#ef4444", label: "Telecel Cash", shortLabel: "TC", value: "telecel" },
      { color: "#2563eb", label: "AT Money", shortLabel: "AT", value: "at" }
    ] as const;
  }

  if (currency === "ZMW") {
    return [
      { color: "#facc15", label: "MTN MoMo", shortLabel: "MT", value: "mtn" },
      { color: "#ef4444", label: "Airtel Money", shortLabel: "AM", value: "airtel" },
      { color: "#16a34a", label: "Zamtel Money", shortLabel: "ZM", value: "zamtel" }
    ] as const;
  }

  return [] as const;
}

function formatMethodLabel(method: CheckoutMethod) {
  return method === "card" ? "Card" : "Mobile money";
}

function formatCardBrand(brand: string) {
  return brand
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCardExpiry(card: CheckoutCardDetails) {
  if (!card.expiry_month || !card.expiry_year) {
    return "Expiry unavailable";
  }

  return `${String(card.expiry_month).padStart(2, "0")}/${String(card.expiry_year).slice(-2)}`;
}

function emptyToNull(value: string | null) {
  return value && value.trim() !== "" ? value : null;
}

function normalizeExpiryYear(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return null;
  }

  if (value.length <= 2) {
    return 2000 + parsed;
  }

  return parsed;
}

function getSimulatorCardScenario(cardNumber: string) {
  if (cardNumber.endsWith("0002")) {
    return "declined" as const;
  }

  if (cardNumber.endsWith("0003")) {
    return "3ds_challenge" as const;
  }

  return "success" as const;
}

function getCardBrand(cardNumber: string) {
  if (cardNumber.startsWith("4")) {
    return "visa";
  }

  if (/^5[1-5]/.test(cardNumber)) {
    return "mastercard";
  }

  return "card";
}

async function submitSimulatorCardResult(input: {
  card: CheckoutCardDetails;
  outcome: "declined" | "succeeded";
  payload: SimulatorCardPayload;
}) {
  const callbackBody = {
    event_type: "collection.updated",
    payment_instrument: {
      brand: input.card.brand,
      expiry_month: input.card.expiry_month,
      expiry_year: input.card.expiry_year,
      last4: input.card.last4
    },
    provider_ref:
      input.outcome === "declined"
        ? `${input.payload.providerRef}_declined`
        : input.payload.providerRef,
    reason: input.outcome === "declined" ? "card_declined" : undefined,
    resource_id: input.payload.collectionId,
    resource_type: "collection",
    to_status: input.outcome
  };

  if (input.payload.callbackUrl) {
    const response = await fetch(input.payload.callbackUrl, {
      body: JSON.stringify(callbackBody),
      headers: {
        "Content-Type": "application/json",
        "x-richespay-simulator-signature": "ok"
      },
      method: "POST"
    });

    if (!response.ok) {
      throw new Error("The simulator callback could not be delivered.");
    }
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      {
        collection_id: input.payload.collectionId,
        outcome: input.outcome,
        source: "richespay-card-simulator",
        type: "card.result"
      },
      "*"
    );
  }
}
