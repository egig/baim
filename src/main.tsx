import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "./index.css";
import Root from "./root";
import Setup from "./routes/setup";
import Generate from "./routes/generate";
import Gallery from "./routes/gallery";

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: "/", element: <Setup /> },
      { path: "/generate", element: <Generate /> },
      { path: "/gallery", element: <Gallery /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
