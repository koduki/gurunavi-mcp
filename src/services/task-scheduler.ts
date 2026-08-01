import { CloudTasksClient, protos } from "@google-cloud/tasks";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";

export interface TaskScheduler {
  scheduleReservationRefresh(
    principalId: string,
    reservationId: string,
    delaySeconds: number,
  ): Promise<void>;
}

export class NoopTaskScheduler implements TaskScheduler {
  scheduleReservationRefresh(
    principalId: string,
    reservationId: string,
    delaySeconds: number,
  ): Promise<void> {
    void principalId;
    void reservationId;
    void delaySeconds;
    return Promise.resolve();
  }
}

export class CloudTaskScheduler implements TaskScheduler {
  readonly #client = new CloudTasksClient();

  constructor(
    readonly config: AppConfig,
    readonly logger: Logger,
  ) {}

  async scheduleReservationRefresh(
    principalId: string,
    reservationId: string,
    delaySeconds: number,
  ): Promise<void> {
    if (
      this.config.googleCloudProject === undefined ||
      this.config.tasksTargetUrl === undefined ||
      this.config.tasksInvokerEmail === undefined
    ) {
      return;
    }
    const parent = this.#client.queuePath(
      this.config.googleCloudProject,
      this.config.cloudTasksLocation,
      this.config.cloudTasksQueue,
    );
    const url = new URL("/internal/tasks/reservation-refresh", this.config.tasksTargetUrl);
    const payload = Buffer.from(
      JSON.stringify({
        principal_id: principalId,
        reservation_id: reservationId,
      }),
      "utf8",
    );
    const task: protos.google.cloud.tasks.v2.ITask = {
      scheduleTime: { seconds: Math.floor(Date.now() / 1000) + delaySeconds },
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: url.toString(),
        headers: { "content-type": "application/json" },
        body: payload,
        oidcToken: {
          serviceAccountEmail: this.config.tasksInvokerEmail,
          audience: this.config.tasksTargetUrl.origin,
        },
      },
    };
    const [created] = await this.#client.createTask({ parent, task });
    this.logger.info(
      { taskName: created.name, reservationId },
      "Scheduled reservation status refresh",
    );
  }
}

export function createTaskScheduler(config: AppConfig, logger: Logger): TaskScheduler {
  return config.googleCloudProject === undefined ||
    config.tasksTargetUrl === undefined ||
    config.tasksInvokerEmail === undefined
    ? new NoopTaskScheduler()
    : new CloudTaskScheduler(config, logger);
}
