"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { UserRepo } from "@/components/custom/WorkspaceBody";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Props = { repo: UserRepo; onScheduleSaved?: () => void };
type Schedule = {
  enabled: number;
  scope: string;
  intervalHours: number;
  notifyEmail: string | null;
  nextRunAt: string | null;
};

const intervals = [6, 12, 24, 48];

export default function ScheduleSettings({ repo, onScheduleSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [scope, setScope] = useState("all");
  const [intervalHours, setIntervalHours] = useState(24);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadSchedule = async () => {
    try {
      const response = await fetch(`/api/schedule?repoId=${repo.repoId}`);
      if (!response.ok) return;
      const data = await response.json();
      const loaded = data.schedule as Schedule | null;
      setSchedule(loaded);
      if (loaded) {
        setEnabled(loaded.enabled === 1);
        setScope(loaded.scope);
        setIntervalHours(loaded.intervalHours);
        setNotifyEmail(loaded.notifyEmail || "");
      }
    } catch {
      // The settings dialog can still be opened and retried after a transient error.
    }
  };

  useEffect(() => { void loadSchedule(); }, [repo.repoId]);

  const saveSchedule = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: repo.repoId,
          repoOwner: repo.owner,
          repoName: repo.name,
          scope,
          intervalHours,
          notifyEmail: notifyEmail.trim() || undefined,
          enabled,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "Could not save schedule");
      setSchedule(data.schedule);
      setMessage("Schedule saved");
      onScheduleSaved?.();
      setTimeout(() => setOpen(false), 700);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save schedule");
    } finally {
      setBusy(false);
    }
  };

  const removeSchedule = async () => {
    if (!window.confirm("Remove the scheduled runs for this repository?")) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/schedule", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: repo.repoId }),
      });
      if (!response.ok) throw new Error("Could not remove schedule");
      setSchedule(null);
      setEnabled(true);
      setMessage("Schedule removed");
      onScheduleSaved?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove schedule");
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = schedule?.enabled === 1
    ? `Scheduled: every ${schedule.intervalHours}h`
    : schedule
      ? "Schedule paused"
      : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <CalendarClock className="h-4 w-4" /> Schedule
          </Button>
        </DialogTrigger>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-lg">
          <DialogHeader>
            <DialogTitle>Schedule automated runs</DialogTitle>
            <DialogDescription>
              Run tests for {repo.fullName} automatically through QStash.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
              Enable schedule
            </label>
            <div>
              <label htmlFor={`schedule-scope-${repo.repoId}`} className="text-sm text-gray-600">Run scope</label>
              <select id={`schedule-scope-${repo.repoId}`} value={scope} onChange={(event) => setScope(event.target.value)} className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm">
                <option value="all">All tests</option>
                <option value="failed">Failed tests only</option>
                <option value="smart">Smart (AI-prioritized)</option>
              </select>
            </div>
            <div>
              <label htmlFor={`schedule-frequency-${repo.repoId}`} className="text-sm text-gray-600">Frequency</label>
              <select id={`schedule-frequency-${repo.repoId}`} value={intervalHours} onChange={(event) => setIntervalHours(Number(event.target.value))} className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm">
                {intervals.map((hours) => <option key={hours} value={hours}>Every {hours} hours{hours === 24 ? " (daily)" : ""}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`schedule-email-${repo.repoId}`} className="text-sm text-gray-600">Notify email (optional)</label>
              <Input id={`schedule-email-${repo.repoId}`} type="email" value={notifyEmail} onChange={(event) => setNotifyEmail(event.target.value)} placeholder="your@email.com" className="mt-1" />
            </div>
            {message && <p className={message.includes("saved") || message.includes("removed") ? "text-sm text-green-700" : "text-sm text-red-600"}>{message}</p>}
          </div>
          <DialogFooter className="gap-2">
            {schedule && <Button variant="destructive" onClick={removeSchedule} disabled={busy}>Remove Schedule</Button>}
            <Button onClick={saveSchedule} disabled={busy} className="gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {activeLabel && <Badge variant="outline" className="text-[10px] whitespace-nowrap">{activeLabel}</Badge>}
    </div>
  );
}