"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId } from "react";
import { Label, Select } from "@/components/field";

/** Task type and vendor filters; they live in the URL so a filtered board can be shared. */
export function Filters({
  taskTypes,
  vendors,
  taskType,
  vendor,
}: {
  taskTypes: string[];
  vendors: string[];
  taskType?: string | undefined;
  vendor?: string | undefined;
}) {
  const id = useId();
  const router = useRouter();
  const path = usePathname();
  const go = (next: { taskType?: string | undefined; vendor?: string | undefined }) => {
    const q = new URLSearchParams();
    const t = "taskType" in next ? next.taskType : taskType;
    const v = "vendor" in next ? next.vendor : vendor;
    if (t) q.set("taskType", t);
    if (v) q.set("vendor", v);
    router.push(q.size ? `${path}?${q}` : path);
  };
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="score-filters">
      <div className="flex min-w-48 flex-col gap-1">
        <Label htmlFor={`${id}-type`}>Task type</Label>
        <Select
          id={`${id}-type`}
          value={taskType ?? ""}
          onChange={(e) => go({ taskType: e.target.value || undefined })}
        >
          <option value="">All task types</option>
          {taskTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-w-40 flex-col gap-1">
        <Label htmlFor={`${id}-vendor`}>Vendor</Label>
        <Select
          id={`${id}-vendor`}
          value={vendor ?? ""}
          onChange={(e) => go({ vendor: e.target.value || undefined })}
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
