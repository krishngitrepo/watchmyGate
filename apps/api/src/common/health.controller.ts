import { Controller, Get } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { getDatabase } from "@watchmygate/db";

@Controller()
export class HealthController {
  /**
   * Liveness only — deliberately does not touch the database.
   *
   * Cloud Run restarts a container that fails this, and restarting will not fix a
   * database outage; it would just cycle every instance during an incident.
   */
  @Get("healthz")
  health(): { status: string } {
    return { status: "ok" };
  }

  /** Readiness — verifies the database is actually reachable. */
  @Get("readyz")
  async ready(): Promise<{ status: string }> {
    await getDatabase().execute(sql`SELECT 1`);
    return { status: "ready" };
  }
}
