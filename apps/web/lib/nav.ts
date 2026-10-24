import {
  BookOpen,
  Bot,
  FlaskConical,
  FolderGit2,
  Gauge,
  Inbox,
  LayoutTemplate,
  type LucideIcon,
  MessageSquare,
  Plug,
  Scale,
  Settings,
  Users,
  Workflow,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV: readonly NavItem[] = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/missions", label: "Missions", icon: Workflow },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/crews", label: "Crews", icon: Users },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/scoreboard", label: "Scoreboard", icon: Gauge },
  { href: "/evals", label: "Evals", icon: FlaskConical },
  { href: "/governance", label: "Governance", icon: Scale },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/docs", label: "Docs", icon: BookOpen },
];
