/**
 * Process-local planning jobs. In-memory only: a restart loses every job by
 * design, and no job is ever retried or restarted implicitly.
 *
 * A job is private: the start response returns a random capability token,
 * and status/cancel require that exact token plus the job id. Tokens are
 * compared in constant time; ids alone disclose nothing. Admission goes
 * through the process-wide SingleRunSlot, shared with the sync endpoints.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PlanningError,
  type PlanRunBudget,
  type RunCoverageSnapshot,
  type RunProgressStats,
} from '@indeev/core';

export interface PlanJobControls {
  /** Aborted on cancel; threaded into the planner and AI call. */
  readonly signal?: AbortSignal;
  /** The one finite budget for the whole job. Never reset by status polling. */
  readonly budget: PlanRunBudget;
  /** Advisory progress sink; never gates execution. */
  readonly onProgress?: (stats: RunProgressStats) => void;
}

export type PlanJobState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PlanJobStatus {
  jobId: string;
  state: PlanJobState;
  startedAt: number;
  finishedAt: number | null;
  /** Null until the first advisory progress event; never an inventory claim. */
  progress: RunProgressStats | null;
  /** Present only on success. */
  result?: unknown;
  /** Present only on failure; coverage stays advisory. */
  error?: {
    code: string;
    message: string;
    cause?: string;
    coverage?: RunCoverageSnapshot;
  };
}

interface JobRecord {
  status: PlanJobStatus;
  controller: AbortController;
  capability: string;
  release: () => void;
}

export interface PlanJobOptions {
  /** At most one active job in this registry; the shared slot is authoritative. */
  maxActive: number;
  /** Finite continuous budget for each job, independent of the sync default. */
  budget: PlanRunBudget;
  /** Terminal snapshots retained for status queries (oldest evicted first). */
  maxRetained?: number;
  /** Process-wide admission gate; a lease is released only when work settles. */
  acquire: () => (() => void) | null;
}

export type PlanJobStart =
  | { ok: true; jobId: string; capability: string }
  | { ok: false; code: 'job_capacity' };

function owns(capability: string, presented: string | undefined): boolean {
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(capability, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeError(err: unknown): NonNullable<PlanJobStatus['error']> {
  if (err instanceof PlanningError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.cause ? { cause: err.cause } : {}),
      ...(err.coverage ? { coverage: err.coverage } : {}),
    };
  }
  return { code: 'job_error', message: err instanceof Error ? err.message : 'Planning failed' };
}

export class PlanJobRegistry<TInput = void> {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(
    private readonly run: (controls: PlanJobControls, input: TInput) => Promise<unknown>,
    private readonly options: PlanJobOptions,
  ) {}

  start(input: TInput): PlanJobStart {
    let active = 0;
    for (const record of this.jobs.values()) {
      if (record.status.state === 'running') active += 1;
    }
    if (active >= this.options.maxActive) return { ok: false, code: 'job_capacity' };
    // Acquire synchronously so a sync request cannot slip into the slot
    // between the capacity check and the scheduled run.
    const release = this.options.acquire();
    if (!release) return { ok: false, code: 'job_capacity' };

    const jobId = randomBytes(16).toString('hex');
    const capability = randomBytes(32).toString('base64url');
    const controller = new AbortController();

    const status: PlanJobStatus = {
      jobId, state: 'running', startedAt: Date.now(), finishedAt: null, progress: null,
    };
    // One finite wall budget for the WHOLE job, including the AI phase.
    // Expiry records an honest terminal deadline; a later resolve from a
    // run that ignored abort can never settle it as success. The slot lease
    // is still held until the actual run settles in the chain below.
    const wallTimer = setTimeout(() => {
      controller.abort();
      this.settle(status, 'failed', {
        error: { code: 'job_deadline', message: 'Job wall budget expired before the run settled.' },
      });
    }, this.options.budget.deadlineMs);
    this.jobs.set(jobId, { status, controller, capability, release });

    const controls: PlanJobControls = {
      signal: controller.signal,
      budget: this.options.budget,
      onProgress: (stats) => {
        if (status.state === 'running') status.progress = stats;
      },
    };

    // The promise chain owns the run; the HTTP request that started it is
    // already free to finish. A rejection is recorded once, never retried.
    // Cancel marks the record terminal but does NOT release the lease: only
    // the actual settle (or full unwind) does.
    void Promise.resolve()
      .then(() => this.run(controls, input))
      .then((result) => this.settle(status, 'succeeded', { result }))
      .catch((err: unknown) => this.settle(status, 'failed', { error: normalizeError(err) }))
      .finally(() => { clearTimeout(wallTimer); release(); });
    return { ok: true, jobId, capability };
  }

  status(jobId: string, capability: string | undefined): PlanJobStatus | undefined {
    const record = this.jobs.get(jobId);
    if (!record || !owns(record.capability, capability)) return undefined;
    const s = record.status;
    return {
      ...s,
      ...(s.progress ? { progress: { ...s.progress } } : {}),
      ...(s.result !== undefined ? { result: s.result } : {}),
      ...(s.error ? { error: { ...s.error } } : {}),
    };
  }

  cancel(jobId: string, capability: string | undefined): boolean {
    const record = this.jobs.get(jobId);
    if (!record || !owns(record.capability, capability) || record.status.state !== 'running') return false;
    // Mark terminal FIRST: a late resolve from an abort-ignoring run must
    // never flip a cancelled job back to succeeded. The slot lease is NOT
    // released here - that happens only when the run itself settles.
    record.status.state = 'cancelled';
    record.status.finishedAt = Date.now();
    record.controller.abort();
    this.prune();
    return true;
  }

  private prune(): void {
    const max = this.options.maxRetained ?? 20;
    const terminal = [...this.jobs.values()].filter((r) => r.status.state !== 'running');
    for (const record of terminal.slice(0, Math.max(0, terminal.length - max))) {
      this.jobs.delete(record.status.jobId);
    }
  }

  private settle(status: PlanJobStatus, state: 'succeeded' | 'failed', patch: Partial<PlanJobStatus>): void {
    if (status.state !== 'running') return;
    status.state = state;
    status.finishedAt = Date.now();
    Object.assign(status, patch);
    this.prune();
  }
}
