import * as React from "react";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useNavigate
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type Session } from "@supabase/supabase-js";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import {
  Button,
  EmptyState,
  Input,
  ToastProvider,
  useToast
} from "@richespay/ui";

import { ApiError, apiRequest } from "./api-client";
import { env } from "./env";
import { AdminWorkspace } from "./routes/admin-workspace";
import { supabase } from "./supabase";

interface AdminSessionData {
  email: string | null;
  role: "super_admin" | "compliance" | "operations" | "finance" | "support";
  user_id: string;
}

interface AuthContextValue {
  accessToken: string | null;
  loading: boolean;
  session: Session | null;
  signOutEverywhere: () => Promise<void>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0
    }
  }
});
const adminIdleTimeoutMs = 30 * 60 * 1000;
const lastActivityStorageKey = "richespay_admin_last_activity";

const AuthContext = React.createContext<AuthContextValue | null>(null);

function useAdminAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAdminAuth must be used inside AdminAuthProvider");
  }

  return context;
}

function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session);
        setLoading(false);
      }
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (!session) {
      return;
    }

    const markActivity = () => {
      window.localStorage.setItem(lastActivityStorageKey, String(Date.now()));
    };

    const events: Array<keyof WindowEventMap> = [
      "click",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart"
    ];

    markActivity();

    events.forEach((eventName) => {
      window.addEventListener(eventName, markActivity, { passive: true });
    });

    const interval = window.setInterval(() => {
      const lastActivity = Number(
        window.localStorage.getItem(lastActivityStorageKey) ?? "0"
      );

      if (Date.now() - lastActivity > adminIdleTimeoutMs) {
        void supabase.auth.signOut({ scope: "local" });
      }
    }, 30_000);

    return () => {
      events.forEach((eventName) => {
        window.removeEventListener(eventName, markActivity);
      });
      window.clearInterval(interval);
    };
  }, [session]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      accessToken: session?.access_token ?? null,
      loading,
      session,
      signOutEverywhere: async () => {
        await supabase.auth.signOut({ scope: "global" });
      }
    }),
    [loading, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function AdminAuthLayout({
  children,
  subtitle,
  title
}: {
  children: React.ReactNode;
  subtitle: string;
  title: string;
}) {
  return (
    <main className="min-h-screen bg-surface-subtle">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
        <section className="flex w-full items-center justify-center px-6 py-10 md:w-1/2 md:px-10">
          <div className="w-full max-w-md rounded-card border border-border bg-white p-8 shadow-soft">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-brand">
              Admin
            </p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-text">
              {title}
            </h1>
            <p className="mt-3 text-sm text-text-secondary">{subtitle}</p>
            <div className="mt-8">{children}</div>
          </div>
        </section>
        <aside className="hidden w-1/2 items-center justify-center bg-brand-50 px-10 py-12 md:flex">
          <div className="max-w-md space-y-6">
            <div className="inline-flex items-center gap-3 rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-brand shadow-softer">
              <ShieldCheck className="size-4" />
              {env.appName}
            </div>
            <h2 className="text-4xl font-semibold tracking-tight text-text">
              RichesPay Admin
            </h2>
            <p className="text-base text-text-secondary">
              Staff access stays visually distinct from the merchant dashboard and every admin session is protected by TOTP plus the IP allowlist.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function ProtectedRoute() {
  const auth = useAdminAuth();
  const location = useLocation();

  if (auth.loading) {
    return (
      <AdminAuthLayout subtitle="Checking your admin session." title="One moment">
        <div className="space-y-4">
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
        </div>
      </AdminAuthLayout>
    );
  }

  if (!auth.session) {
    return <Navigate replace state={{ from: location.pathname }} to="/sign-in" />;
  }

  return <Outlet />;
}

function SignInPage() {
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  return (
    <AdminAuthLayout
      subtitle="Platform admins must complete password sign-in and TOTP before the admin session is accepted."
      title="Sign in"
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setLoading(true);

          const { error } = await supabase.auth.signInWithPassword({
            email,
            password
          });

          setLoading(false);

          if (error) {
            pushToast({
              description: error.message,
              title: "Admin sign-in failed",
              variant: "danger"
            });
            return;
          }

          navigate("/2fa", { replace: true });
        }}
      >
        <Input label="Email" onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
        <Input label="Password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        <Button className="w-full" loading={loading} type="submit" variant="primary">
          Sign in
        </Button>
      </form>
    </AdminAuthLayout>
  );
}

function TwoFactorPage() {
  const { pushToast } = useToast();
  const auth = useAdminAuth();
  const navigate = useNavigate();
  const [code, setCode] = React.useState("");
  const [factorId, setFactorId] = React.useState("");
  const [qrCode, setQrCode] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState("");
  const [mode, setMode] = React.useState<"loading" | "enroll" | "verify">("loading");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!auth.session) {
      if (!auth.loading) {
        navigate("/sign-in", { replace: true });
      }
      return;
    }

    let mounted = true;

    void (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();

      if (!mounted) {
        return;
      }

      if (error) {
        pushToast({
          description: error.message,
          title: "Unable to load 2FA factors",
          variant: "danger"
        });
        setMode("enroll");
        return;
      }

      const verifiedFactor = data?.totp.find((factor) => factor.status === "verified");
      setMode(verifiedFactor ? "verify" : "enroll");
    })();

    return () => {
      mounted = false;
    };
  }, [auth.loading, auth.session, navigate, pushToast]);

  async function enrollTotp() {
    setLoading(true);
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "RichesPay admin"
    });
    setLoading(false);

    if (error || !data) {
      pushToast({
        description: error?.message ?? "Unable to start TOTP setup.",
        title: "2FA setup failed",
        variant: "danger"
      });
      return;
    }

    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
  }

  async function verifyTotp() {
    if (!auth.session) {
      navigate("/sign-in", { replace: true });
      return;
    }

    setLoading(true);

    let activeFactorId = factorId;

    if (!activeFactorId) {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      const factor =
        data?.totp.find((entry) => entry.status === "verified") ?? data?.totp[0];

      if (listError || !factor) {
        setLoading(false);
        pushToast({
          description: "Set up authenticator 2FA before verifying a code.",
          title: "2FA is missing",
          variant: "danger"
        });
        setMode("enroll");
        return;
      }

      activeFactorId = factor.id;
    }

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: activeFactorId
    });

    if (challengeError || !challenge) {
      setLoading(false);
      pushToast({
        description: challengeError?.message ?? "Unable to challenge the admin factor",
        title: "2FA challenge failed",
        variant: "danger"
      });
      return;
    }

    const { error } = await supabase.auth.mfa.verify({
      challengeId: challenge.id,
      code,
      factorId: activeFactorId
    });

    setLoading(false);

    if (error) {
      pushToast({
        description: error.message,
        title: "Verification failed",
        variant: "danger"
      });
      return;
    }

    navigate("/app/overview", { replace: true });
  }

  if (mode === "loading" || auth.loading) {
    return (
      <AdminAuthLayout subtitle="Checking your admin 2FA requirements." title="One moment">
        <div className="space-y-4">
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <Button
            className="w-full"
            onClick={() => void auth.signOutEverywhere()}
            variant="secondary"
          >
            Sign out
          </Button>
        </div>
      </AdminAuthLayout>
    );
  }

  if (mode === "enroll") {
    return (
      <AdminAuthLayout
        subtitle="Platform admins must enroll a TOTP authenticator before the admin session is accepted."
        title="Set up admin 2FA"
      >
        <div className="space-y-4">
          {!factorId ? (
            <Button className="w-full" loading={loading} onClick={() => void enrollTotp()} variant="primary">
              Generate QR code
            </Button>
          ) : (
            <>
              {qrCode ? (
                <img
                  alt="RichesPay admin TOTP QR code"
                  className="mx-auto h-48 w-48 rounded-card border border-border bg-white p-3"
                  src={qrCode}
                />
              ) : null}
              <Input label="Secret" readOnly value={secret} />
              <Input
                label="Authenticator code"
                onChange={(event) => setCode(event.target.value)}
                value={code}
              />
              <Button className="w-full" loading={loading} onClick={() => void verifyTotp()} variant="primary">
                Verify and continue
              </Button>
            </>
          )}
        </div>
      </AdminAuthLayout>
    );
  }

  return (
    <AdminAuthLayout
      subtitle="Enter the authenticator code for your platform admin account."
      title="Verify your admin session"
    >
      <div className="space-y-4">
        <Input label="Authentication code" onChange={(event) => setCode(event.target.value)} value={code} />
        <Button className="w-full" loading={loading} onClick={() => void verifyTotp()} variant="primary">
          Verify code
        </Button>
      </div>
    </AdminAuthLayout>
  );
}

function AdminWorkspacePage() {
  const auth = useAdminAuth();
  const { pushToast } = useToast();
  const [sessionData, setSessionData] = React.useState<AdminSessionData | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!auth.accessToken) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setFailure(null);

    void (async () => {
      try {
        const data = await apiRequest<AdminSessionData>("/admin/v1/session", {
          accessToken: auth.accessToken
        });
        if (!cancelled) {
          setSessionData(data);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof ApiError && error.code === "mfa_required") {
          window.location.assign("/2fa");
          return;
        }

        const message =
          error instanceof ApiError ? error.message : "Unable to load admin session";
        setFailure(message);
        pushToast({
          description: message,
          title: "Admin access denied",
          variant: "danger"
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, auth.accessToken, pushToast]);

  if (loading) {
    return (
      <AdminAuthLayout subtitle="Loading the RichesPay Admin workspace." title="One moment">
        <div className="space-y-4">
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <Button
            className="w-full"
            onClick={() => void auth.signOutEverywhere()}
            variant="secondary"
          >
            Sign out
          </Button>
        </div>
      </AdminAuthLayout>
    );
  }

  if (!sessionData || !auth.accessToken) {
    return (
      <AdminAuthLayout
        subtitle={failure ?? "This account did not pass the admin access checks."}
        title="Admin access unavailable"
      >
        <div className="space-y-4">
          <EmptyState
            description={failure ?? "This account did not pass the admin access checks."}
            icon={<LockKeyhole className="size-5" />}
            title="Admin access unavailable"
          />
          <Button className="w-full" onClick={() => setAttempt((current) => current + 1)} variant="primary">
            Try again
          </Button>
          <Button
            className="w-full"
            onClick={() => void auth.signOutEverywhere()}
            variant="secondary"
          >
            Sign out
          </Button>
        </div>
      </AdminAuthLayout>
    );
  }

  return (
    <AdminWorkspace
      accessToken={auth.accessToken}
      onSignOutEverywhere={auth.signOutEverywhere}
      sessionData={sessionData}
    />
  );
}

const router = createBrowserRouter([
  { path: "/", element: <Navigate replace to="/sign-in" /> },
  { path: "/sign-in", element: <SignInPage /> },
  { path: "/2fa", element: <TwoFactorPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      { path: "/app", element: <Navigate replace to="/app/overview" /> },
      { path: "/app/overview", element: <AdminWorkspacePage /> },
      { path: "/app/merchants", element: <AdminWorkspacePage /> },
      { path: "/app/merchants/:merchantId", element: <AdminWorkspacePage /> },
      { path: "/app/kyb", element: <AdminWorkspacePage /> },
      { path: "/app/compliance-flags", element: <AdminWorkspacePage /> },
      { path: "/app/channels", element: <AdminWorkspacePage /> },
      { path: "/app/transactions", element: <AdminWorkspacePage /> },
      { path: "/app/reconciliation", element: <AdminWorkspacePage /> },
      { path: "/app/sender-ids", element: <AdminWorkspacePage /> },
      { path: "/app/airtime", element: <AdminWorkspacePage /> },
      { path: "/app/pricing", element: <AdminWorkspacePage /> },
      { path: "/app/admin-users", element: <AdminWorkspacePage /> },
      { path: "/app/audit", element: <AdminWorkspacePage /> }
    ]
  }
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AdminAuthProvider>
          <RouterProvider router={router} />
        </AdminAuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
