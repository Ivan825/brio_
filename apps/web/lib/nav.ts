import { Bot, Gauge, type LucideIcon, Plug, Settings, Workflow } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV: readonly NavItem[] = [
  { href: "/missions", label: "Missions", icon: Workflow },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/scoreboard", label: "Scoreboard", icon: Gauge },
  { href: "/settings", label: "Settings", icon: Settings },
];
