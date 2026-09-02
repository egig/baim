import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import Root from "./root";
import Assets, { loader as assetsLoader } from "./routes/assets";
import Templates from "./routes/templates";
import Generations from "./routes/generations";

const queryClient = new QueryClient();

const router = createMemoryRouter([
  {
    element: <Root />,
    children: [
      { path: "/", element: <Assets />, loader: assetsLoader(queryClient) },
      { path: "/templates", element: <Templates /> },
      { path: "/history", element: <Generations /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
