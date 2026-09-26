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
import {
  Building2,
  KeyRound,
  LogOut,
  Mail,
  ShieldCheck,
  UserPlus
} from "lucide-react";
import {
  AppShell,
  Button,
  CopyField,
  DataTable,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  ToastProvider,
  useToast,
  type ColumnDef
} from "@richespay/ui";
import {
  settlementCurrencyForCountry,
  type MerchantRole
} from "@richespay/shared";

import { ApiError, apiRequest } from "./api-client";
import { supabase } from "./supabase";

type MerchantMode = "live" | "test";

interface MembershipSummary {
  merchant_id: string;
  merchant_name: string;
  mode: MerchantMode;
  role: MerchantRole;
  settlement_currency: string;
  timezone: string;
}

interface DashboardSessionData {
  email: string | null;
  merchant_id: string;
  merchant_name: string;
  mode: MerchantMode;
  permissions: string[];
  role: MerchantRole;
  settlement_currency: string;
  user_id: string;
}

interface TeamMember {
  email: string | null;
  full_name: string | null;
  role: MerchantRole;
  user_id: string;
}

interface InvitePreview {
  email: string;
  expires_at: string;
  merchant_id: string;
  role: MerchantRole;
}

interface AuthContextValue {
  accessToken: string | null;
  loading: boolean;
  session: Session | null;
  signOutEverywhere: () => Promise<void>;
}

const queryClient = new QueryClient();
const roleOptions = [
  { label: "Owner", value: "owner" },
  { label: "Admin", value: "admin" },
  { label: "Finance", value: "finance" },
  { label: "Developer", value: "developer" },
  { label: "Support", value: "support" },
  { label: "Viewer", value: "viewer" }
] as const;
const countryOptions = [
  { label: "Ghana", value: "GH" },
  { label: "Zambia", value: "ZM" },
  { label: "Other", value: "OTHER" }
] as const;
const lastActivityStorageKey = "richespay_dashboard_last_activity";
const selectedMerchantStorageKey = "richespay_dashboard_merchant_id";
const signUpEmailStorageKey = "richespay_dashboard_signup_email";
const inviteTokenStorageKey = "richespay_dashboard_invite_token";
const dashboardIdleTimeoutMs = 12 * 60 * 60 * 1000;

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

    const bootstrap = async () => {
      const { data } = await supabase.auth.getSession();
      if (mounted) {
        setSession(data.session);
        setLoading(false);
      }
    };

    void bootstrap();

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
      window.localStorage.setItem(
        lastActivityStorageKey,
        String(Date.now())
      );
    };

    markActivity();

    const events: Array<keyof WindowEventMap> = [
      "click",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart"
    ];

    events.forEach((eventName) => {
      window.addEventListener(eventName, markActivity, { passive: true });
    });

    const interval = window.setInterval(() => {
      const lastActivity = Number(
        window.localStorage.getItem(lastActivityStorageKey) ?? "0"
      );

      if (Date.now() - lastActivity > dashboardIdleTimeoutMs) {
        void supabase.auth.signOut({ scope: "local" });
      }
    }, 60_000);

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
              Calm access for every merchant and every team.
            </h2>
            <p className="text-base text-text-secondary">
              Email verification, merchant-aware access, and TOTP protection for
              the roles that move money and manage the team.
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
  const { pushToast } = useToast();
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  return (
    <AuthSplitLayout
      eyebrow="Dashboard"
      subtitle="Sign in with your work email. Owners, admins, and finance users will be prompted for TOTP before merchant access opens."
      title="Welcome back"
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
              title: "Sign-in failed",
              variant: "danger"
            });
            return;
          }

          navigate("/app", { replace: true });
        }}
      >
        <Input
          autoComplete="email"
          label="Email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          type="email"
          value={email}
        />
        <Input
          autoComplete="current-password"
          label="Password"
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          type="password"
          value={password}
        />
        <Button className="w-full" loading={loading} type="submit" variant="primary">
          Sign in
        </Button>
      </form>
      <div className="mt-5 flex flex-col gap-3 text-sm text-text-secondary">
        <Link className="text-brand hover:underline" to="/forgot-password">
          Forgot your password?
        </Link>
        <p>
          New to RichesPay?{" "}
          <Link className="text-brand hover:underline" to="/sign-up">
            Create your merchant account
          </Link>
        </p>
        {auth.session ? (
          <Button
            className="justify-start px-0"
            onClick={() => {
              void auth.signOutEverywhere();
            }}
            variant="ghost"
          >
            <LogOut className="size-4" />
            Sign out everywhere
          </Button>
        ) : null}
      </div>
    </AuthSplitLayout>
  );
}

function SignUpPage() {
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const [businessName, setBusinessName] = React.useState("");
  const [countryCode, setCountryCode] = React.useState("GH");
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const settlementCurrency = settlementCurrencyForCountry(
    countryCode === "OTHER" ? "OTHER" : countryCode
  );

  return (
    <AuthSplitLayout
      eyebrow="Onboarding"
      subtitle="Create a verified RichesPay account, lock in your settlement currency, and start in pending KYB."
      title="Create your merchant account"
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setLoading(true);

          try {
            await apiRequest<{
              merchant_id: string;
              settlement_currency: string;
              user_id: string;
              verification_required: true;
            }>("/dashboard/v1/auth/sign-up", {
              body: JSON.stringify({
                business_name: businessName,
                country_code: countryCode === "OTHER" ? "KE" : countryCode,
                email,
                full_name: fullName,
                password
              }),
              method: "POST"
            });

            window.localStorage.setItem(signUpEmailStorageKey, email);
            navigate("/verify-email", { replace: true });
          } catch (error) {
            pushToast({
              description:
                error instanceof ApiError ? error.message : "Unable to sign up",
              title: "Sign-up failed",
              variant: "danger"
            });
          } finally {
            setLoading(false);
          }
        }}
      >
        <Input
          label="Full name"
          onChange={(event) => {
            setFullName(event.target.value);
          }}
          value={fullName}
        />
        <Input
          label="Business name"
          onChange={(event) => {
            setBusinessName(event.target.value);
          }}
          value={businessName}
        />
        <Select
          label="Country"
          onValueChange={setCountryCode}
          options={countryOptions}
          value={countryCode}
        />
        <div className="rounded-input border border-border bg-surface-subtle px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
            Settlement currency
          </p>
          <p className="mt-2 text-base font-semibold text-text">
            Your settlement currency: {settlementCurrency}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            This is locked after country selection.
          </p>
        </div>
        <Input
          autoComplete="email"
          label="Email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          type="email"
          value={email}
        />
        <Input
          autoComplete="new-password"
          label="Password"
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          type="password"
          value={password}
        />
        <Button className="w-full" loading={loading} type="submit" variant="primary">
          Create account
        </Button>
      </form>
      <p className="mt-5 text-sm text-text-secondary">
        Already have an account?{" "}
        <Link className="text-brand hover:underline" to="/sign-in">
          Sign in
        </Link>
      </p>
    </AuthSplitLayout>
  );
}

function VerifyEmailPage() {
  const { pushToast } = useToast();
  const storedEmail = window.localStorage.getItem(signUpEmailStorageKey) ?? "";
  const [email, setEmail] = React.useState(storedEmail);
  const [loading, setLoading] = React.useState(false);

  return (
    <AuthSplitLayout
      eyebrow="Verify Email"
      subtitle="Check your inbox for the RichesPay verification link before signing in."
      title="Verify your email"
    >
      <div className="space-y-4">
        <div className="rounded-card border border-border bg-surface-subtle p-4 text-sm text-text-secondary">
          We sent a verification email to <strong className="text-text">{email}</strong>.
        </div>
        <Input
          label="Email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          type="email"
          value={email}
        />
        <Button
          className="w-full"
          loading={loading}
          onClick={async () => {
            setLoading(true);

            const { error } = await supabase.auth.resend({
              email,
              options: {
                emailRedirectTo: `${window.location.origin}/verify-email`
              },
              type: "signup"
            });

            setLoading(false);

            pushToast({
              description: error ? error.message : "A fresh verification email is on the way.",
              title: error ? "Unable to resend" : "Verification email sent",
              variant: error ? "danger" : "success"
            });
          }}
          variant="primary"
        >
          Resend verification email
        </Button>
        <Link className="text-sm text-brand hover:underline" to="/sign-in">
          I have already verified my email
        </Link>
      </div>
    </AuthSplitLayout>
  );
}

function SetupTwoFactorPage() {
  const { pushToast } = useToast();
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const [factorId, setFactorId] = React.useState<string | null>(null);
  const [qrCode, setQrCode] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!auth.session) {
      navigate("/sign-in", { replace: true });
      return;
    }

    void (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const existingFactor = data?.totp[0];

      if (existingFactor) {
        setFactorId(existingFactor.id);
        return;
      }

      const { data: enrollment, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "RichesPay Dashboard"
      });

      if (error || !enrollment) {
        pushToast({
          description: error?.message ?? "Unable to start TOTP setup",
          title: "2FA setup failed",
          variant: "danger"
        });
        return;
      }

      setFactorId(enrollment.id);
      setQrCode(enrollment.totp.qr_code);
      setSecret(enrollment.totp.secret);
    })();
  }, [auth.session, navigate, pushToast]);

  return (
    <AuthSplitLayout
      eyebrow="TOTP Setup"
      subtitle="Owners, admins, and finance users need an AAL2 session before dashboard access is granted."
      title="Set up two-factor authentication"
    >
      <div className="space-y-4">
        {qrCode ? (
          <div
            className="rounded-card border border-border bg-white p-4"
            dangerouslySetInnerHTML={{ __html: qrCode }}
          />
        ) : (
          <div className="rounded-card border border-border bg-surface-subtle p-4 text-sm text-text-secondary">
            If you already enrolled TOTP, enter a fresh code from your authenticator app below.
          </div>
        )}
        {secret ? <CopyField label="Manual setup key" value={secret} /> : null}
        <Input
          label="Authentication code"
          onChange={(event) => {
            setCode(event.target.value);
          }}
          value={code}
        />
        <Button
          className="w-full"
          loading={loading}
          onClick={async () => {
            if (!factorId) {
              return;
            }

            setLoading(true);
            const { data: challenge, error: challengeError } =
              await supabase.auth.mfa.challenge({ factorId });

            if (challengeError || !challenge) {
              setLoading(false);
              pushToast({
                description:
                  challengeError?.message ?? "Unable to challenge TOTP factor",
                title: "2FA challenge failed",
                variant: "danger"
              });
              return;
            }

            const { error } = await supabase.auth.mfa.verify({
              challengeId: challenge.id,
              code,
              factorId
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

            navigate("/app", { replace: true });
          }}
          variant="primary"
        >
          Verify and continue
        </Button>
      </div>
    </AuthSplitLayout>
  );
}

function EnterTwoFactorPage() {
  const { pushToast } = useToast();
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  return (
    <AuthSplitLayout
      eyebrow="Two-Factor Authentication"
      subtitle="Enter the 6-digit code from your authenticator app to continue."
      title="Confirm your sign-in"
    >
      <div className="space-y-4">
        <Input
          label="Authentication code"
          onChange={(event) => {
            setCode(event.target.value);
          }}
          value={code}
        />
        <Button
          className="w-full"
          loading={loading}
          onClick={async () => {
            if (!auth.session) {
              navigate("/sign-in", { replace: true });
              return;
            }

            setLoading(true);
            const { data, error: listError } = await supabase.auth.mfa.listFactors();
            const factor = data?.totp[0];

            if (listError || !factor) {
              setLoading(false);
              navigate("/setup-2fa", { replace: true });
              return;
            }

            const { data: challenge, error: challengeError } =
              await supabase.auth.mfa.challenge({ factorId: factor.id });

            if (challengeError || !challenge) {
              setLoading(false);
              pushToast({
                description:
                  challengeError?.message ?? "Unable to request a TOTP challenge",
                title: "2FA challenge failed",
                variant: "danger"
              });
              return;
            }

            const { error } = await supabase.auth.mfa.verify({
              challengeId: challenge.id,
              code,
              factorId: factor.id
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

            navigate("/app", { replace: true });
          }}
          variant="primary"
        >
          Verify code
        </Button>
        <Button
          className="w-full"
          onClick={() => {
            navigate("/setup-2fa");
          }}
          variant="secondary"
        >
          Set up TOTP instead
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
      eyebrow="Password Reset"
      subtitle="We’ll send a reset link to the email on your RichesPay account."
      title="Forgot your password?"
    >
      <div className="space-y-4">
        <Input
          label="Email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          type="email"
          value={email}
        />
        <Button
          className="w-full"
          loading={loading}
          onClick={async () => {
            setLoading(true);

            const { error } = await supabase.auth.resetPasswordForEmail(email, {
              redirectTo: `${window.location.origin}/sign-in`
            });

            setLoading(false);

            pushToast({
              description: error ? error.message : "Check your inbox for the reset link.",
              title: error ? "Reset failed" : "Reset link sent",
              variant: error ? "danger" : "success"
            });
          }}
          variant="primary"
        >
          Send reset link
        </Button>
      </div>
    </AuthSplitLayout>
  );
}

function AcceptInvitePage() {
  const { pushToast } = useToast();
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? window.localStorage.getItem(inviteTokenStorageKey) ?? "";
  const [preview, setPreview] = React.useState<InvitePreview | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!token) {
      return;
    }

    window.localStorage.setItem(inviteTokenStorageKey, token);

    void (async () => {
      try {
        const data = await apiRequest<InvitePreview>(
          `/dashboard/v1/auth/invitations/${token}`
        );
        setPreview(data);
      } catch (error) {
        pushToast({
          description:
            error instanceof ApiError ? error.message : "Unable to load invitation",
          title: "Invitation unavailable",
          variant: "danger"
        });
      }
    })();
  }, [pushToast, token]);

  return (
    <AuthSplitLayout
      eyebrow="Accept Invite"
      subtitle="Join the merchant team with the role that was assigned to you."
      title="You’ve been invited"
    >
      <div className="space-y-4">
        {preview ? (
          <div className="rounded-card border border-border bg-surface-subtle p-4 text-sm text-text-secondary">
            <p>
              Invitation for <strong className="text-text">{preview.email}</strong>
            </p>
            <p className="mt-2">
              Merchant: <strong className="text-text">{preview.merchant_id}</strong>
            </p>
            <p className="mt-1">
              Role: <strong className="text-text">{preview.role}</strong>
            </p>
          </div>
        ) : (
          <div className="rounded-card border border-border bg-surface-subtle p-4 text-sm text-text-secondary">
            Loading invitation details...
          </div>
        )}
        {auth.session ? (
          <Button
            className="w-full"
            loading={loading}
            onClick={async () => {
              if (!auth.accessToken || !token) {
                return;
              }

              setLoading(true);

              try {
                const data = await apiRequest<{
                  merchant_id: string;
                  mode: MerchantMode;
                  role: MerchantRole;
                }>("/dashboard/v1/auth/accept-invite", {
                  accessToken: auth.accessToken,
                  body: JSON.stringify({ token }),
                  method: "POST"
                });

                window.localStorage.setItem(
                  selectedMerchantStorageKey,
                  data.merchant_id
                );
                window.localStorage.removeItem(inviteTokenStorageKey);
                navigate("/app", { replace: true });
              } catch (error) {
                pushToast({
                  description:
                    error instanceof ApiError ? error.message : "Unable to accept the invitation",
                  title: "Invite acceptance failed",
                  variant: "danger"
                });
              } finally {
                setLoading(false);
              }
            }}
            variant="primary"
          >
            Accept invitation
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Sign in first, then come back here to accept the invite.
            </p>
            <Link className="text-sm text-brand hover:underline" to="/sign-in">
              Go to sign in
            </Link>
          </div>
        )}
      </div>
    </AuthSplitLayout>
  );
}

function DashboardHomePage() {
  const { pushToast } = useToast();
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const [memberships, setMemberships] = React.useState<MembershipSummary[]>([]);
  const [selectedMerchantId, setSelectedMerchantId] = React.useState<string>(
    window.localStorage.getItem(selectedMerchantStorageKey) ?? ""
  );
  const [sessionData, setSessionData] = React.useState<DashboardSessionData | null>(null);
  const [members, setMembers] = React.useState<TeamMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<MerchantRole>("viewer");
  const [latestInviteUrl, setLatestInviteUrl] = React.useState<string | null>(null);
  const [editingMember, setEditingMember] = React.useState<TeamMember | null>(null);
  const [nextRole, setNextRole] = React.useState<MerchantRole>("viewer");
  const [busyMemberId, setBusyMemberId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!auth.accessToken) {
      return;
    }

    void (async () => {
      try {
        const data = await apiRequest<MembershipSummary[]>(
          "/dashboard/v1/auth/memberships",
          {
            accessToken: auth.accessToken
          }
        );
        setMemberships(data);

        const preferredMerchant =
          data.find((membership) => membership.merchant_id === selectedMerchantId)
            ?.merchant_id ?? data[0]?.merchant_id ?? "";

        if (preferredMerchant) {
          setSelectedMerchantId(preferredMerchant);
          window.localStorage.setItem(
            selectedMerchantStorageKey,
            preferredMerchant
          );
        }
      } catch (error) {
        pushToast({
          description:
            error instanceof ApiError ? error.message : "Unable to load memberships",
          title: "Memberships unavailable",
          variant: "danger"
        });
      }
    })();
  }, [auth.accessToken, pushToast, selectedMerchantId]);

  React.useEffect(() => {
    if (!auth.accessToken || !selectedMerchantId) {
      setLoading(false);
      return;
    }

    setLoading(true);

    void (async () => {
      try {
        const session = await apiRequest<DashboardSessionData>(
          "/dashboard/v1/session",
          {
            accessToken: auth.accessToken,
            merchantId: selectedMerchantId
          }
        );
        setSessionData(session);

        const teamMembers = await apiRequest<TeamMember[]>(
          "/dashboard/v1/team/members",
          {
            accessToken: auth.accessToken,
            merchantId: selectedMerchantId
          }
        );
        setMembers(teamMembers);
      } catch (error) {
        if (error instanceof ApiError && error.code === "mfa_required") {
          navigate("/enter-2fa", { replace: true });
          return;
        }

        pushToast({
          description:
            error instanceof ApiError ? error.message : "Unable to load dashboard session",
          title: "Dashboard unavailable",
          variant: "danger"
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [auth.accessToken, navigate, pushToast, selectedMerchantId]);

  const membershipOptions = memberships.map((membership) => ({
    label: `${membership.merchant_name} (${membership.mode})`,
    value: membership.merchant_id
  }));

  const columns = React.useMemo<ColumnDef<TeamMember>[]>(
    () => [
      {
        accessorKey: "full_name",
        header: "Name",
        cell: ({ row }) => row.original.full_name ?? "No profile name"
      },
      {
        accessorKey: "email",
        header: "Email",
        cell: ({ row }) => row.original.email ?? "No email"
      },
      {
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => row.original.role
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setEditingMember(row.original);
                setNextRole(row.original.role);
              }}
              variant="ghost"
            >
              Change role
            </Button>
            <Button
              onClick={async () => {
                if (!auth.accessToken || !sessionData) {
                  return;
                }

                setBusyMemberId(row.original.user_id);

                try {
                  await apiRequest<{ removed: true }>(
                    `/dashboard/v1/team/members/${row.original.user_id}`,
                    {
                      accessToken: auth.accessToken,
                      merchantId: sessionData.merchant_id,
                      method: "DELETE"
                    }
                  );

                  setMembers((current) =>
                    current.filter((member) => member.user_id !== row.original.user_id)
                  );
                } catch (error) {
                  pushToast({
                    description:
                      error instanceof ApiError ? error.message : "Unable to remove member",
                    title: "Member removal failed",
                    variant: "danger"
                  });
                } finally {
                  setBusyMemberId(null);
                }
              }}
              variant="danger"
            >
              {busyMemberId === row.original.user_id ? "Removing..." : "Remove"}
            </Button>
          </div>
        )
      }
    ],
    [auth.accessToken, busyMemberId, pushToast, sessionData]
  );

  if (loading) {
    return (
      <AuthSplitLayout
        eyebrow="Dashboard"
        subtitle="Loading your merchant workspace."
        title="Preparing access"
      >
        <div className="space-y-4">
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <div className="h-11 animate-pulse rounded-input bg-surface-subtle" />
          <div className="h-40 animate-pulse rounded-card bg-surface-subtle" />
        </div>
      </AuthSplitLayout>
    );
  }

  if (memberships.length === 0 || !sessionData) {
    return (
      <AuthSplitLayout
        eyebrow="Dashboard"
        subtitle="You can join another merchant with an invite or complete onboarding on a new account."
        title="No merchant access yet"
      >
        <EmptyState
          action={
            <Link to="/accept-invite">
              <Button variant="primary">Accept an invite</Button>
            </Link>
          }
          description="Your user is signed in, but there are no merchant memberships on this account yet."
          icon={<UserPlus className="size-5" />}
          title="No merchant memberships"
        />
      </AuthSplitLayout>
    );
  }

  return (
    <>
      <AppShell
        activePath="/app"
        mode={sessionData.mode}
        navItems={[{ href: "/app", icon: <ShieldCheck className="size-4" />, label: "Team" }]}
        onModeChange={(mode) => {
          const alternative = memberships.find(
            (membership) =>
              membership.mode === mode &&
              membership.merchant_name === sessionData.merchant_name
          );

          if (alternative) {
            setSelectedMerchantId(alternative.merchant_id);
            window.localStorage.setItem(
              selectedMerchantStorageKey,
              alternative.merchant_id
            );
            return;
          }

          pushToast({
            description: `No ${mode} membership is available for this merchant yet.`,
            title: "Mode not available",
            variant: "warning"
          });
        }}
        title="RichesPay Dashboard"
        topBarContent={
          <div className="flex items-center gap-3">
            <Select
              onValueChange={(value) => {
                setSelectedMerchantId(value);
                window.localStorage.setItem(selectedMerchantStorageKey, value);
              }}
              options={membershipOptions}
              value={selectedMerchantId}
            />
            <Button
              onClick={() => {
                void auth.signOutEverywhere();
              }}
              variant="secondary"
            >
              <LogOut className="size-4" />
              Sign out everywhere
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <PageHeader
            action={
              <Button
                leadingIcon={<Mail className="size-4" />}
                onClick={() => {
                  setInviteOpen(true);
                }}
                variant="primary"
              >
                Invite teammate
              </Button>
            }
            subtitle={`Signed in as ${sessionData.email ?? "unknown email"} with ${sessionData.role} access.`}
            title={sessionData.merchant_name}
          />
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              icon={<ShieldCheck className="size-4" />}
              label="Your role"
              value={sessionData.role}
            />
            <StatCard
              icon={<Building2 className="size-4" />}
              label="Settlement currency"
              value={sessionData.settlement_currency}
            />
            <StatCard
              icon={<KeyRound className="size-4" />}
              label="Granted permissions"
              value={String(sessionData.permissions.length)}
            />
          </div>
          <DataTable
            columns={columns}
            data={members}
            emptyState={
              <EmptyState
                description="Invite your first teammate to start sharing access."
                title="No team members yet"
              />
            }
            pageInfo={{
              hasNextPage: false,
              hasPreviousPage: false,
              limit: members.length || 10
            }}
          />
        </div>
      </AppShell>

      <Modal
        description="Send a role-based invite link to another team member."
        onOpenChange={setInviteOpen}
        open={inviteOpen}
        title="Invite teammate"
      >
        <div className="space-y-4">
          <Input
            label="Teammate email"
            onChange={(event) => {
              setInviteEmail(event.target.value);
            }}
            type="email"
            value={inviteEmail}
          />
          <Select
            label="Role"
            onValueChange={(value) => {
              setInviteRole(value as MerchantRole);
            }}
            options={roleOptions}
            value={inviteRole}
          />
          <Button
            className="w-full"
            onClick={async () => {
              if (!auth.accessToken || !sessionData) {
                return;
              }

              try {
                const data = await apiRequest<{
                  expires_at: string;
                  invite_url: string;
                  role: MerchantRole;
                }>("/dashboard/v1/team/invite", {
                  accessToken: auth.accessToken,
                  body: JSON.stringify({
                    email: inviteEmail,
                    role: inviteRole
                  }),
                  merchantId: sessionData.merchant_id,
                  method: "POST"
                });

                setLatestInviteUrl(data.invite_url);
                pushToast({
                  description: "Invite link created. Share it securely with the teammate.",
                  title: "Invite ready",
                  variant: "success"
                });
              } catch (error) {
                pushToast({
                  description:
                    error instanceof ApiError ? error.message : "Unable to create invite",
                  title: "Invite failed",
                  variant: "danger"
                });
              }
            }}
            variant="primary"
          >
            Create invite
          </Button>
          {latestInviteUrl ? <CopyField label="Invite URL" value={latestInviteUrl} /> : null}
        </div>
      </Modal>

      <Modal
        description="Change this teammate’s dashboard access role."
        onOpenChange={(open) => {
          if (!open) {
            setEditingMember(null);
          }
        }}
        open={editingMember !== null}
        title="Change member role"
      >
        <div className="space-y-4">
          <Select
            label="Role"
            onValueChange={(value) => {
              setNextRole(value as MerchantRole);
            }}
            options={roleOptions}
            value={nextRole}
          />
          <Button
            className="w-full"
            onClick={async () => {
              if (!auth.accessToken || !sessionData || !editingMember) {
                return;
              }

              try {
                const data = await apiRequest<{
                  role: MerchantRole;
                  user_id: string;
                }>(`/dashboard/v1/team/members/${editingMember.user_id}`, {
                  accessToken: auth.accessToken,
                  body: JSON.stringify({ role: nextRole }),
                  merchantId: sessionData.merchant_id,
                  method: "PATCH"
                });

                setMembers((current) =>
                  current.map((member) =>
                    member.user_id === data.user_id
                      ? { ...member, role: data.role }
                      : member
                  )
                );
                setEditingMember(null);
              } catch (error) {
                pushToast({
                  description:
                    error instanceof ApiError ? error.message : "Unable to update role",
                  title: "Role update failed",
                  variant: "danger"
                });
              }
            }}
            variant="primary"
          >
            Save role
          </Button>
        </div>
      </Modal>
    </>
  );
}

function StatCard({
  icon,
  label,
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <section className="rounded-card border border-border bg-white p-5 shadow-softer">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="mt-2 text-xl font-semibold text-text">{value}</p>
        </div>
        <div className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-brand">
          {icon}
        </div>
      </div>
    </section>
  );
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
    element: <DashboardProtectedRoute />,
    children: [
      {
        path: "/app",
        element: <DashboardHomePage />
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
