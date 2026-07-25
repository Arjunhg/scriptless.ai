"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { UserRepo } from "@/components/custom/WorkspaceBody";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Props = { repo: UserRepo };
type RunLog = {
  id: number;
  scope: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  durationMs: number;
  status: string;
  createdAt: string;
};

function statusClass(status: string): string {
  if (status === "completed") return "border-green-200 bg-green-50 text-green-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

export default function ScheduleHistory({ repo }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<RunLog[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/schedule/logs?repoId=${repo.repoId}`)
      .then((response) => response.ok ? response.json() : { logs: [] })
      .then((data) => { if (!cancelled) setLogs(Array.isArray(data.logs) ? data.logs : []); })
      .catch(() => { if (!cancelled) setLogs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repo.repoId]);

  return (
    <div className="border rounded-lg bg-white">
      <Button variant="ghost" className="w-full justify-between px-3" onClick={() => setOpen((value) => !value)}>
        <span>Scheduled run history</span><ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>
      {open && <div className="border-t px-3 py-3 space-y-2">
        {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
        {!loading && logs.length === 0 && <p className="text-sm text-gray-500">No scheduled runs yet. Set up a schedule to get started.</p>}
        {!loading && logs.map((log) => (
          <div key={log.id} className="flex flex-col gap-1 rounded-md border p-2 text-xs sm:flex-row sm:items-center sm:gap-3">
            <span className="text-gray-500 sm:w-36">{new Date(log.createdAt).toLocaleString()}</span>
            <span className="capitalize text-gray-600">{log.scope}</span>
            <span><span className="text-green-700">{log.passedTests} passed</span> · <span className="text-red-700">{log.failedTests} failed</span>{log.skippedTests ? ` · ${log.skippedTests} skipped` : ""}</span>
            <span className="text-gray-500">{Math.round(log.durationMs / 1000)}s</span>
            <Badge variant="outline" className={`sm:ml-auto ${statusClass(log.status)}`}>{log.status}</Badge>
          </div>
        ))}
      </div>}
    </div>
  );
}