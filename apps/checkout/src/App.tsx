import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import { env } from "./env";

const queryClient = new QueryClient();

function PlaceholderPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-12 text-slate-900">
      <div className="mx-auto max-w-5xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand">
          Hosted checkout
        </span>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">
          {env.appName}
        </h1>
        <p className="mt-3 max-w-2xl text-base text-slate-600">
          The checkout shell is ready. It includes routing, query state, the
          shared design-system package reference, and a typed API client wrapper
          without payment flows yet.
        </p>
        <dl className="mt-8 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 p-4">
            <dt className="text-sm text-slate-500">API base URL</dt>
            <dd className="mt-2 font-medium text-slate-900">{env.apiBaseUrl}</dd>
          </div>
          <div className="rounded-2xl border border-slate-200 p-4">
            <dt className="text-sm text-slate-500">Surface</dt>
            <dd className="mt-2 font-medium text-slate-900">Checkout app</dd>
          </div>
          <div className="rounded-2xl border border-slate-200 p-4">
            <dt className="text-sm text-slate-500">UI package</dt>
            <dd className="mt-2 font-medium text-slate-900">@richespay/ui</dd>
          </div>
        </dl>
      </div>
    </main>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <PlaceholderPage />
  }
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
