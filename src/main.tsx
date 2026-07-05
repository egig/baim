import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "./index.css";
import Root from "./root";
import Settings from "./routes/settings";
import Assets from "./routes/assets";

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: "/settings", element: <Settings /> },
      { path: "/", element: <Assets /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
