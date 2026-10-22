import type { ReactNode } from "react";
import { AppShell } from "../../components/AppShell";
export default function L({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
