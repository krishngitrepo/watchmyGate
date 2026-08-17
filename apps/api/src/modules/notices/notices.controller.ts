import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { NoticesService } from "./notices.service.js";

const createSchema = z.object({
  kind: z.enum(["circular", "event", "poll", "emergency"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  audience: z.enum(["society", "tower", "owners", "tenants", "committee", "custom"]),
  audienceRef: z.unknown().optional(),
  isPinned: z.boolean().optional(),
  publishAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  eventAt: z.string().datetime().optional(),
  eventPlace: z.string().max(200).optional(),
  options: z.array(z.string().min(1).max(200)).min(2).max(12).optional(),
});

/**
 * Notices.
 *
 * Reading is open to every member of the society; writing is committee work. Anyone can
 * vote and mark-as-read for themselves — those routes derive the person from the token
 * and never accept a person id, so one resident cannot vote as another.
 */
@Controller("v1/notices")
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  async feed(@Query("limit") limit?: string) {
    return this.notices.feed(limit ? Number(limit) : undefined);
  }

  @Post()
  async create(@Body() body: unknown) {
    this.requireCommittee();
    return this.notices.create(createSchema.parse(body));
  }

  @Post(":id/publish")
  async publish(@Param("id") id: string) {
    this.requireCommittee();
    return this.notices.publish(id);
  }

  @Post(":id/read")
  async markRead(@Param("id") id: string) {
    return this.notices.markRead(id);
  }

  @Post(":id/vote")
  async vote(@Param("id") id: string, @Body() body: unknown) {
    const { optionId } = z.object({ optionId: z.string().uuid() }).parse(body);
    return this.notices.vote(id, optionId);
  }

  @Get(":id/results")
  async results(@Param("id") id: string) {
    return this.notices.results(id);
  }

  @Get(":id/reads")
  async reads(@Param("id") id: string) {
    this.requireCommittee();
    return this.notices.readCount(id);
  }

  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can publish notices.");
    }
  }
}
