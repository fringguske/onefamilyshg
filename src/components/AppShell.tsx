"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/client";

const NAV = [
  { href: "/", label: "Group summary" },
  { href: "/month", label: "Monthly records" },
  { href: "/mgr", label: "Merry go round" },
  { href: "/members", label: "Member records" },
  { href: "/members/register", label: "Registration" },
  { href: "/bonus", label: "Bonus" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ user, groupName, children }: { user: { name: string; role: string }; groupName: string; children: ReactNode }) {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/" ? path === "/" : href === "/members" ? path === "/members" || /^\/members\/(?!register)/.test(path) : path.startsWith(href);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/login";
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">{groupName}</div>
        <div className="user">
          <span>
            {user.name} <span className="role-chip">{user.role === "admin" ? "Administrator" : "Chairman"}</span>
          </span>
          <button className="btn btn-ghost-light" onClick={logout}>Log out</button>
        </div>
      </header>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
