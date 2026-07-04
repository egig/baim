import { Link, Outlet, useLocation } from "react-router";

const navLinks = [
  { to: "/", label: "API Key" },
  { to: "/generate", label: "Generate" },
  { to: "/gallery", label: "Gallery" },
];

export default function Root() {
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800">
        <nav className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-6">
          <h1 className="text-lg font-semibold text-white mr-4">
            Catalog Image Generator
          </h1>
          {navLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`text-sm transition-colors ${
                location.pathname === link.to
                  ? "text-white font-medium"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="flex-1 max-w-4xl mx-auto px-4 py-8 w-full">
        <Outlet />
      </main>
    </div>
  );
}
