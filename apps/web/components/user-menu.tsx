"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "./button";

export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-1">
      <span className="hidden font-mono text-2xs text-fg-subtle lg:inline">{email}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        title="Sign out"
        onClick={async () => {
          await authClient.signOut();
          router.push("/sign-in");
          router.refresh();
        }}
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  );
}
