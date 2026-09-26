import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, createBrowserRouter, RouterProvider } from "react-router-dom";

import { ToastProvider } from "@richespay/ui";

import { UIKitPage } from "./routes/ui-kit-page";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate replace to="/ui-kit" />
  },
  {
    path: "/ui-kit",
    element: <UIKitPage />
  }
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
