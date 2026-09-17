import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { I18nProvider } from "./lib/i18n";
import Root from "./root";
import Browser from "./routes/browser";
import Templates from "./routes/templates";
import Generations from "./routes/generations";

const queryClient = new QueryClient();

const router = createMemoryRouter([
  {
    element: <Root />,
    children: [
      { path: "/", element: <Browser /> },
      { path: "/templates", element: <Templates /> },
      { path: "/history", element: <Generations /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>
);
