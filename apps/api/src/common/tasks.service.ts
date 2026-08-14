/**
 * Deferred work — Cloud Tasks with scheduled delivery.
 *
 * Cloud Run kills a container once it returns a response, so there is nowhere in a
 * request-scoped app for "call this resident again in 20 seconds" to live. Cloud Tasks'
 * `scheduleTime` maps onto the approval ladder exactly: enqueue one task per rung at
 * the moment it is due, and the worker service handles it.
 *
 * Local mode uses in-process timers so the ladder is demonstrable with no GCP account.
 * That is explicitly NOT production behaviour — timers die with the process — and it
 * says so loudly in the log rather than quietly behaving differently.
 */

import { Injectable } from "@nestjs/common";

import { loadConfig } from "./config.js";

export interface TaskRequest {
  /** Worker path, e.g. `/tasks/approval-rung`. */
  path: string;
  payload: Record<string, unknown>;
  delaySeconds: number;
  /**
   * Stable name for deduplication. Cloud Tasks rejects a duplicate name for ~1 hour
   * after completion, which stops a retried request scheduling the same rung twice.
   */
  dedupeName?: string;
}

@Injectable()
export class TasksService {
  private readonly config = loadConfig();
  private readonly localTimers = new Map<string, NodeJS.Timeout>();

  async schedule(task: TaskRequest): Promise<void> {
    if (this.config.tasksAreStubbed) {
      this.scheduleLocally(task);
      return;
    }
    await this.enqueueCloudTask(task);
  }

  /**
   * Local fallback: a real timer in this process.
   *
   * Good enough to demo and test the full ladder end to end. Not good enough for
   * production, for the obvious reason that a deploy or a crash silently drops every
   * pending rung — which is why the worker exists.
   */
  private scheduleLocally(task: TaskRequest): void {
    const key = task.dedupeName ?? `${task.path}:${JSON.stringify(task.payload)}`;
    if (this.localTimers.has(key)) return; // same dedup semantics as Cloud Tasks

    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: "task_stub_scheduled",
        path: task.path,
        delaySeconds: task.delaySeconds,
        detail:
          "LOCAL ONLY — in-process timer. Pending work is lost on restart. Configure " +
          "GCP_PROJECT_ID and WORKER_BASE_URL for Cloud Tasks.",
      }),
    );

    const timer = setTimeout(() => {
      this.localTimers.delete(key);
      void this.callWorkerDirectly(task);
    }, task.delaySeconds * 1000);

    // Do not hold the process open just for a pending rung.
    timer.unref?.();
    this.localTimers.set(key, timer);
  }

  private async callWorkerDirectly(task: TaskRequest): Promise<void> {
    const base = this.config.WORKER_BASE_URL ?? `http://localhost:${this.config.PORT}`;
    try {
      await fetch(`${base}${task.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.SERVICE_TOKEN
            ? { "x-service-token": this.config.SERVICE_TOKEN }
            : {}),
        },
        body: JSON.stringify(task.payload),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: "task_stub_failed",
          path: task.path,
          error: (error as Error).message,
        }),
      );
    }
  }

  /**
   * Enqueue against the Cloud Tasks REST API.
   *
   * Deliberately plain `fetch` rather than the Google client library: this is one call,
   * and the library pulls in gRPC and a large dependency tree for it. The OIDC token
   * for the worker is minted by Cloud Tasks itself from `WORKER_SERVICE_ACCOUNT`, so
   * the worker can verify the caller without us handling a credential here.
   */
  private async enqueueCloudTask(task: TaskRequest): Promise<void> {
    const { GCP_PROJECT_ID, GCP_REGION, CLOUD_TASKS_QUEUE, WORKER_BASE_URL } = this.config;
    const parent = `projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/queues/${CLOUD_TASKS_QUEUE}`;
    const url = `https://cloudtasks.googleapis.com/v2/${parent}/tasks`;

    const body = {
      task: {
        ...(task.dedupeName ? { name: `${parent}/tasks/${task.dedupeName}` } : {}),
        scheduleTime: new Date(Date.now() + task.delaySeconds * 1000).toISOString(),
        httpRequest: {
          url: `${WORKER_BASE_URL}${task.path}`,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(task.payload)).toString("base64"),
          ...(this.config.WORKER_SERVICE_ACCOUNT
            ? {
                oidcToken: {
                  serviceAccountEmail: this.config.WORKER_SERVICE_ACCOUNT,
                  audience: WORKER_BASE_URL,
                },
              }
            : {}),
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await this.metadataToken()}`,
      },
      body: JSON.stringify(body),
    });

    // 409 means the task name already exists — the rung is already scheduled, which is
    // the correct outcome of a retry rather than an error to surface.
    if (!response.ok && response.status !== 409) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: "cloud_task_enqueue_failed",
          status: response.status,
          path: task.path,
        }),
      );
    }
  }

  /** Access token from the Cloud Run metadata server. No key file involved. */
  private async metadataToken(): Promise<string> {
    const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }
}
