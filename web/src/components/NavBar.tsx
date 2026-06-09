import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function NavBar() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();

  function navLink(to: string, label: string) {
    const active = pathname === to;
    return (
      <Link
        to={to}
        className={`px-3 py-1.5 text-sm no-underline rounded-md transition-all duration-200 ${
          active
            ? "bg-navy-100 text-navy-900 font-medium"
            : "text-navy-500 hover:text-navy-800 hover:bg-navy-50"
        }`}
      >
        {label}
      </Link>
    );
  }

  return (
    <nav className="bg-white/80 backdrop-blur-lg border-b border-navy-100 sticky top-0 z-40">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-2.5">
        <Link
          to="/"
          className="text-lg font-bold tracking-tight text-brand-700 no-underline flex items-center gap-1.5"
        >
          AP Automation
        </Link>
        <div className="flex items-center gap-1">
          {navLink("/", "Dashboard")}
          {navLink("/admin/funding", "Funding")}
          {navLink("/webhooks", "Events")}
          {navLink("/collab-auth", "Collab Auth")}
          {navLink("/simulate", "Simulate")}
          {user && (
            <span className="ml-2 px-2 py-1 text-sm text-navy-600">
              {user.email}
            </span>
          )}
          <button
            onClick={logout}
            className="ml-1 px-3 py-1.5 text-sm text-navy-400 hover:text-navy-700 rounded-md hover:bg-navy-50 transition-all duration-200"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
