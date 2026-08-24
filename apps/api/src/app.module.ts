import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";

import { TenantMiddleware } from "./common/tenant.middleware.js";
import { HealthController } from "./common/health.controller.js";
import { AnalyticsController } from "./modules/analytics/analytics.controller.js";
import { AnalyticsService } from "./modules/analytics/analytics.service.js";
import { DeliveriesController } from "./modules/deliveries/deliveries.controller.js";
import { SafetyController } from "./modules/safety/safety.controller.js";
import { SafetyService } from "./modules/safety/safety.service.js";
import { MigrationController } from "./modules/migration/migration.controller.js";
import { MigrationService } from "./modules/migration/migration.service.js";
import { NoticesController } from "./modules/notices/notices.controller.js";
import { NoticesService } from "./modules/notices/notices.service.js";
import { ParkingController } from "./modules/parking/parking.controller.js";
import { ParkingService } from "./modules/parking/parking.service.js";
import { DeliveriesService } from "./modules/deliveries/deliveries.service.js";
import { StorageService } from "./common/storage.service.js";
import { TasksService } from "./common/tasks.service.js";
import { AuthController } from "./modules/auth/auth.controller.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { BillingController } from "./modules/billing/billing.controller.js";
import { BillingService } from "./modules/billing/billing.service.js";
import { ApprovalService } from "./modules/gate/approval.service.js";
import { GateController } from "./modules/gate/gate.controller.js";
import { GateService } from "./modules/gate/gate.service.js";
import { HelpdeskController } from "./modules/helpdesk/helpdesk.controller.js";
import { InternalController } from "./modules/internal/internal.controller.js";
import { HelpdeskService } from "./modules/helpdesk/helpdesk.service.js";
import { LedgerController } from "./modules/ledger/ledger.controller.js";
import { LedgerService } from "./modules/ledger/ledger.service.js";
import { ReportsService } from "./modules/ledger/reports.service.js";
import { TallyService } from "./modules/ledger/tally.service.js";
import { PaymentsController } from "./modules/payments/payments.controller.js";
import { PaymentsService } from "./modules/payments/payments.service.js";
import { SocietyController } from "./modules/society/society.controller.js";
import { StaffController } from "./modules/staff/staff.controller.js";
import { StaffService } from "./modules/staff/staff.service.js";
import { SocietyService } from "./modules/society/society.service.js";
import { SmsService } from "./modules/notify/sms.service.js";

/**
 * Single module for now, deliberately.
 *
 * The architecture is a modular monolith: boundaries are enforced by directory and by
 * lint rather than by splitting into Nest feature modules prematurely. Splitting comes
 * when a module has a reason to be extracted, not before.
 */
@Module({
  controllers: [
    HealthController,
    AuthController,
    BillingController,
    HelpdeskController,
    GateController,
    InternalController,
    SocietyController,
    PaymentsController,
    StaffController,
    DeliveriesController,
    NoticesController,
    ParkingController,
    SafetyController,
    AnalyticsController,
    MigrationController,
    LedgerController,
  ],
  providers: [
    AuthService,
    SmsService,
    StorageService,
    TasksService,
    LedgerService,
    ReportsService,
    TallyService,
    BillingService,
    HelpdeskService,
    GateService,
    ApprovalService,
    SocietyService,
    PaymentsService,
    StaffService,
    DeliveriesService,
    NoticesService,
    ParkingService,
    SafetyService,
    AnalyticsService,
    MigrationService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to everything. The middleware itself decides what is public — keeping
    // that list in one place means a new route is protected by default rather than
    // accidentally open.
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
