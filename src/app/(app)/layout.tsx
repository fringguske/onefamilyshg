import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getSession, getSettings } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const settings = await getSettings().catch(() => ({ group_name: "One Family Merry-Go-Round" }));
  return (
    <AppShell user={{ name: session.name, role: session.role }} groupName={settings.group_name}>
      {children}
    </AppShell>
  );
}
