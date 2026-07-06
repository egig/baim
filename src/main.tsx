import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import Root from "./root";
import Settings from "./routes/settings";
import Assets, { loader as assetsLoader } from "./routes/assets";
import Generations from "./routes/generations";

const queryClient = new QueryClient();

const router = createMemoryRouter([
  {
    element: <Root />,
    children: [
      { path: "/settings", element: <Settings /> },
      { path: "/generations", element: <Generations /> },
      { path: "/", element: <Assets />, loader: assetsLoader(queryClient) },
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
