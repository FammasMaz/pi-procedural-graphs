/**
 * Trajectory tracking: task boundaries, action/observation recording, and the
 * recent-window used for guidance (paper: T_{t-w:t}).
 */
import type { StepRecord } from "./graph";

export interface ActiveTask {
  id: string;
  query: string;
  steps: StepRecord[];
  startedAt: number;
  endedAt?: number;
}

export class Tracker {
  /** Task currently being solved (null when idle). */
  currentTask: ActiveTask | null = null;
  /** Last recorded tool action name, used for localization (a_{t-1} in the paper). */
  lastToolName: string | null = null;
  /** Ring of the last `window` steps across the current task. */
  private windowSteps: StepRecord[] = [];
  private seq = 0;

  reset(): void {
    this.currentTask = null;
    this.lastToolName = null;
    this.windowSteps = [];
  }

  /** Called on before_agent_start (a new user prompt) or /pg task start. */
  startTask(query: string): void {
    this.currentTask = { id: `task-${++this.seq}`, query, steps: [], startedAt: Date.now() };
    this.windowSteps = [];
  }

  get hasActiveTask(): boolean {
    return this.currentTask !== null;
  }

  get taskStepCount(): number {
    return this.currentTask?.steps.length ?? 0;
  }

  recordAction(tool: string, args?: string): void {
    if (!this.currentTask) return;
    this.lastToolName = tool;
    const step: StepRecord = { tool, args, ok: true };
    this.currentTask.steps.push(step);
    this.windowSteps.push(step);
    this.trimWindow();
  }

  /** Attach the observation to the most recent unobserved step for `tool`. */
  recordObservation(tool: string, ok: boolean, obs?: string): void {
    if (!this.currentTask) return;
    const steps = this.currentTask.steps;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.tool === tool && s.obs === undefined && s.ok === true) {
        s.ok = ok;
        s.obs = obs;
        // Mirror into the window ring.
        const w = this.windowSteps;
        for (let j = w.length - 1; j >= 0; j--) {
          if (w[j] === s) {
            w[j] = { ...s };
            break;
          }
        }
        return;
      }
    }
    // No matching action (e.g. action recorded before task start); append.
    const step: StepRecord = { tool, ok, obs };
    this.currentTask.steps.push(step);
    this.windowSteps.push(step);
    this.trimWindow();
  }

  hasError(): boolean {
    return this.currentTask?.steps.some((s) => s.ok === false) ?? false;
  }

  endTask(): (ActiveTask & { endedAt: number }) | null {
    if (!this.currentTask) return null;
    const finished = { ...this.currentTask, endedAt: Date.now() };
    this.currentTask = null;
    this.lastToolName = null;
    this.windowSteps = [];
    return finished;
  }

  /** Recent window (paper: last w steps), oldest first. */
  window(size: number): StepRecord[] {
    return this.windowSteps.slice(-size);
  }

  private trimWindow(): void {
    // Keep a generous 32-step ceiling regardless of config window.
    if (this.windowSteps.length > 32) this.windowSteps = this.windowSteps.slice(-32);
  }
}

export function formatSteps(steps: StepRecord[]): string {
  if (steps.length === 0) return "(no tool steps yet)";
  return steps
    .map((s, i) => {
      const head = `${i + 1}. ${s.tool}${s.args ? ` ${s.args}` : ""}`;
      const obs = s.obs ? ` → ${s.obs}` : "";
      const flag = s.ok ? "" : " [ERROR]";
      return `${head}${flag}${obs}`;
    })
    .join("\n");
}