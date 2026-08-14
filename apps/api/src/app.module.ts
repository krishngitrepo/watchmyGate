import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";

import { TenantMiddleware } from "./common/tenant.middleware.js";
import { HealthController } from "./common/health.controller.js";
import { AuthController } from "./modules/auth/auth.controller.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { BillingController } from "./modules/billing/billing.controller.js";
import { BillingService } from "./modules/billing/billing.service.js";
import { LedgerService } from "./modules/ledger/ledger.service.js";
import { SmsService } from "./modules/notify/sms.service.js";

/**
 * Single module for now, deliberately.
 *
 * The architecture is a modular monolith: boundaries are enforced by directory and by
 * lint rather than by splitting into Nest feature modules prematurely. Splitting comes
 * when a module has a reason to be extracted, not before.
 */
@Module({
  controllers: [HealthController, AuthController, BillingController],
  providers: [AuthService, SmsService, LedgerService, BillingService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to everything. The middleware itself decides what is public — keeping
    // that list in one place means a new route is protected by default rather than
    // accidentally open.
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
