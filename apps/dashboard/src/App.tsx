import * as React from "react";
import {
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useNavigate,
  useSearchParams
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type Session } from "@supabase/supabase-js";
import { Building2 } from "lucide-react";
import { Button, Input, ToastProvider, useToast } from "@richespay/ui";

import { ApiError, apiRequest } from "./api-client";
import { MerchantWorkspace } from "./routes/merchant-workspace";
import { UIKitPage } from "./routes/ui-kit-page";
import { supabase } from "./supabase";

const queryClient = new QueryClient();
const signUpEmailStorageKey = "richespay_dashboard_signup_email";

interface AuthContextValue {
  accessToken: string | null;
  loading: boolean;
  session: Session | null;
  signOutEverywhere: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function useDashboardAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useDashboardAuth must be used inside DashboardAuthProvider");
  }

  return context;
}

function DashboardAuthProvider({ children }: { children: React.ReactNode }) {
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

function AuthSplitLayout({
  children,
  eyebrow,
  subtitle,
  title
}: {
  children: React.ReactNode;
  eyebrow: string;
  subtitle: string;
  title: string;
}) {
  return (
    <main className="min-h-screen bg-surface-subtle">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
        <section className="flex w-full items-center justify-center px-6 py-10 md:w-1/2 md:px-10">
          <div className="w-full max-w-md rounded-card border border-border bg-white p-8 shadow-soft">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-brand">
              {eyebrow}
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
              <Building2 className="size-4" />
              RichesPay
            </div>
            <h2 className="text-4xl font-semibold tracking-tight text-text">
              Premium merchant operations for payments and messaging.
            </h2>
            <p className="text-base text-text-secondary">
              Sign in securely, switch between test and live, and manage every
              active product from one dashboard.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function DashboardProtectedRoute() {
  const auth = useDashboardAuth();
  const location = useLocation();

  if (auth.loading) {
    return (
      <AuthSplitLayout
        eyebrow="Dashboard"
        subtitle="Checking your session."
        title="One moment"
      >
        <div className="space-y-4">
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
        </div>
      </AuthSplitLayout>
    );
  }

  if (!auth.session) {
    return <Navigate replace state={{ from: location.pathname }} to="/sign-in" />;
  }

  return <Outlet />;
}

function SignInPage() {
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/app/overview";

  if (auth.session) {
    return <Navigate replace to={from} />;
  }

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Use your verified merchant account to access the RichesPay dashboard."
      title="Sign in"
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setSubmitting(true);

          const { error } = await supabase.auth.signInWithPassword({
            email,
            password
          });

          setSubmitting(false);

          if (error) {
            pushToast({
              title: "Sign-in failed",
              description: error.message,
              variant: "danger"
            });
            return;
          }

          navigate(from, { replace: true });
        }}
      >
        <Input
          autoComplete="email"
          label="Email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
        <Input
          autoComplete="current-password"
          label="Password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
        <Button className="w-full" loading={submitting} type="submit" variant="primary">
          Sign in
        </Button>
        <div className="flex flex-wrap justify-between gap-3 text-sm">
          <Link className="text-brand underline" to="/forgot-password">
            Forgot password
          </Link>
          <Link className="text-brand underline" to="/sign-up">
            Create account
          </Link>
        </div>
      </form>
    </AuthSplitLayout>
  );
}

function SignUpPage() {
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [businessName, setBusinessName] = React.useState("");
  const [countryCode, setCountryCode] = React.useState("GH");
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Create a merchant owner account and start onboarding your business."
      title="Create your account"
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setSubmitting(true);

          try {
            await apiRequest("/dashboard/v1/auth/sign-up", {
              body: JSON.stringify({
                business_name: businessName,
                country_code: countryCode,
                email,
                full_name: fullName,
                password
              }),
              method: "POST"
            });

            window.localStorage.setItem(signUpEmailStorageKey, email);
            navigate("/verify-email");
          } catch (error) {
            pushToast({
              title: "Sign-up failed",
              description: error instanceof ApiError ? error.message : "Unable to create the account.",
              variant: "danger"
            });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Input label="Business name" onChange={(event) => setBusinessName(event.target.value)} value={businessName} />
        <Input label="Country code" onChange={(event) => setCountryCode(event.target.value.toUpperCase())} value={countryCode} />
        <Input label="Full name" onChange={(event) => setFullName(event.target.value)} value={fullName} />
        <Input label="Email" onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
        <Input label="Password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        <Button className="w-full" loading={submitting} type="submit" variant="primary">
          Create account
        </Button>
        <p className="text-sm text-text-secondary">
          Your settlement currency is fixed from the onboarding country.
        </p>
      </form>
    </AuthSplitLayout>
  );
}

function VerifyEmailPage() {
  const email = window.localStorage.getItem(signUpEmailStorageKey);

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Check your inbox, verify the email, then come back here to sign in."
      title="Verify your email"
    >
      <div className="space-y-4 text-sm text-text-secondary">
        <p>We sent a verification link to {email ?? "your email address"}.</p>
        <p>
          Once verified, you can sign in and continue with KYB, settlement
          setup, and your first test transaction.
        </p>
        <Link to="/sign-in">
          <Button variant="primary">Back to sign in</Button>
        </Link>
      </div>
    </AuthSplitLayout>
  );
}

function SetupTwoFactorPage() {
  const { pushToast } = useToast();
  const [factorId, setFactorId] = React.useState("");
  const [qrCode, setQrCode] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState("");
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  async function handleEnroll() {
    setLoading(true);
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "RichesPay dashboard"
    });
    setLoading(false);

    if (error || !data) {
      pushToast({
        title: "2FA setup failed",
        description: error?.message ?? "Unable to start TOTP setup.",
        variant: "danger"
      });
      return;
    }

    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
  }

  async function handleVerify() {
    if (!factorId) {
      return;
    }

    setLoading(true);
    const challenge = await supabase.auth.mfa.challenge({ factorId });

    if (challenge.error || !challenge.data) {
      setLoading(false);
      pushToast({
        title: "2FA challenge failed",
        description: challenge.error?.message ?? "Unable to create the TOTP challenge.",
        variant: "danger"
      });
      return;
    }

    const verified = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code
    });
    setLoading(false);

    if (verified.error) {
      pushToast({
        title: "Verification failed",
        description: verified.error.message,
        variant: "danger"
      });
      return;
    }

    pushToast({
      title: "2FA enabled",
      description: "Your TOTP factor is ready to use.",
      variant: "success"
    });
  }

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Set up a TOTP second factor for roles that move money or manage access."
      title="Set up 2FA"
    >
      <div className="space-y-4">
        {!factorId ? (
          <Button loading={loading} onClick={() => void handleEnroll()} variant="primary">
            Generate QR code
          </Button>
        ) : (
          <>
            {qrCode ? (
              <img
                alt="RichesPay TOTP QR code"
                className="h-48 w-48 rounded-card border border-border bg-white p-3"
                src={qrCode}
              />
            ) : null}
            <Input label="Secret" readOnly value={secret} />
            <Input label="Authenticator code" onChange={(event) => setCode(event.target.value)} value={code} />
            <Button loading={loading} onClick={() => void handleVerify()} variant="primary">
              Verify code
            </Button>
          </>
        )}
      </div>
    </AuthSplitLayout>
  );
}

function EnterTwoFactorPage() {
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Enter the code from your authenticator app to continue."
      title="Complete 2FA"
    >
      <div className="space-y-4">
        <Input label="Authenticator code" onChange={(event) => setCode(event.target.value)} value={code} />
        <Button
          loading={loading}
          onClick={async () => {
            setLoading(true);
            const factors = await supabase.auth.mfa.listFactors();
            const factorId = factors.data?.all?.[0]?.id;

            if (!factorId) {
              setLoading(false);
              pushToast({
                title: "No factor found",
                description: "Set up TOTP first before entering a code.",
                variant: "warning"
              });
              return;
            }

            const challenge = await supabase.auth.mfa.challenge({ factorId });
            if (challenge.error || !challenge.data) {
              setLoading(false);
              pushToast({
                title: "Challenge failed",
                description: challenge.error?.message ?? "Unable to create a 2FA challenge.",
                variant: "danger"
              });
              return;
            }

            const verified = await supabase.auth.mfa.verify({
              factorId,
              challengeId: challenge.data.id,
              code
            });
            setLoading(false);

            if (verified.error) {
              pushToast({
                title: "Verification failed",
                description: verified.error.message,
                variant: "danger"
              });
              return;
            }

            navigate("/app/overview", { replace: true });
          }}
          variant="primary"
        >
          Continue
        </Button>
      </div>
    </AuthSplitLayout>
  );
}

function ForgotPasswordPage() {
  const { pushToast } = useToast();
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Request a password reset email for your RichesPay dashboard account."
      title="Reset password"
    >
      <div className="space-y-4">
        <Input label="Email" onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
        <Button
          loading={loading}
          onClick={async () => {
            setLoading(true);
            const { error } = await supabase.auth.resetPasswordForEmail(email, {
              redirectTo: `${window.location.origin}/sign-in`
            });
            setLoading(false);

            if (error) {
              pushToast({
                title: "Reset failed",
                description: error.message,
                variant: "danger"
              });
              return;
            }

            pushToast({
              title: "Reset email sent",
              description: "Check your inbox for the password reset link.",
              variant: "success"
            });
          }}
          variant="primary"
        >
          Send reset email
        </Button>
      </div>
    </AuthSplitLayout>
  );
}

function AcceptInvitePage() {
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [preview, setPreview] = React.useState<{
    email: string;
    expires_at: string;
    merchant_id: string;
    role: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!token) {
      return;
    }

    void apiRequest(`/dashboard/v1/auth/invitations/${token}`)
      .then((data) => {
        setPreview(data as typeof preview);
      })
      .catch(() => {
        setPreview(null);
      });
  }, [token]);

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Accept your merchant invite after signing in to the dashboard."
      title="Accept invite"
    >
      <div className="space-y-4">
        {preview ? (
          <div className="rounded-card border border-border bg-surface-subtle p-4 text-sm text-text-secondary">
            <p className="font-medium text-text">Invite preview</p>
            <p className="mt-2">Email: {preview.email}</p>
            <p>Role: {preview.role}</p>
            <p>Expires: {new Date(preview.expires_at).toLocaleString()}</p>
          </div>
        ) : null}
        {!auth.session ? (
          <Link to="/sign-in">
            <Button variant="primary">Sign in to accept</Button>
          </Link>
        ) : (
          <Button
            loading={loading}
            onClick={async () => {
              if (!token) {
                return;
              }

              setLoading(true);
              try {
                await apiRequest("/dashboard/v1/auth/accept-invite", {
                  accessToken: auth.accessToken,
                  body: JSON.stringify({ token }),
                  method: "POST"
                });
                navigate("/app/overview", { replace: true });
              } catch (error) {
                pushToast({
                  title: "Invite failed",
                  description: error instanceof ApiError ? error.message : "Unable to accept the invite.",
                  variant: "danger"
                });
              } finally {
                setLoading(false);
              }
            }}
            variant="primary"
          >
            Accept invite
          </Button>
        )}
      </div>
    </AuthSplitLayout>
  );
}

function DashboardWorkspacePage() {
  const auth = useDashboardAuth();
  return <MerchantWorkspace auth={auth} />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate replace to="/sign-in" />
  },
  {
    path: "/sign-in",
    element: <SignInPage />
  },
  {
    path: "/sign-up",
    element: <SignUpPage />
  },
  {
    path: "/verify-email",
    element: <VerifyEmailPage />
  },
  {
    path: "/setup-2fa",
    element: <SetupTwoFactorPage />
  },
  {
    path: "/enter-2fa",
    element: <EnterTwoFactorPage />
  },
  {
    path: "/forgot-password",
    element: <ForgotPasswordPage />
  },
  {
    path: "/accept-invite",
    element: <AcceptInvitePage />
  },
  {
    path: "/ui-kit",
    element: <UIKitPage />
  },
  {
    element: <DashboardProtectedRoute />,
    children: [
      {
        path: "/app",
        element: <Navigate replace to="/app/overview" />
      },
      {
        path: "/app/overview",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/collections",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/payouts",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/payment-links",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/messages",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/sender-ids",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/contacts",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/balance",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/developers",
        element: <DashboardWorkspacePage />
      },
      {
        path: "/app/settings",
        element: <DashboardWorkspacePage />
      }
    ]
  }
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DashboardAuthProvider>
          <RouterProvider router={router} />
        </DashboardAuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
