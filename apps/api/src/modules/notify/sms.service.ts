/**
 * SMS via MSG91.
 *
 * TRAI/DLT: every commercial SMS in India needs a DLT-registered header and template.
 * The template *category* is part of its registration, not a runtime flag, and it
 * decides whether the message may reach a number on the DND registry. Login OTP is
 * transactional and may. Dues reminders are service-explicit and need prior consent.
 *
 * Stub mode writes the code to the log so the whole auth flow works locally with no
 * cloud account. Config refuses to boot production without credentials, so this cannot
 * ship by accident.
 */

import { Injectable } from "@nestjs/common";

import { loadConfig } from "../../common/config.js";
import { UpstreamError } from "../../common/errors.js";

const MSG91_OTP_URL = "https://control.msg91.com/api/v5/otp";
const MSG91_FLOW_URL = "https://control.msg91.com/api/v5/flow";

export type TemplateCategory =
  | "transactional"
  | "service_explicit"
  | "service_implicit"
  | "promotional";

@Injectable()
export class SmsService {
  private readonly config = loadConfig();

  async sendOtp(phone: string, code: string): Promise<void> {
    if (this.config.smsIsStubbed) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: "sms_stub_otp",
          phone,
          code,
          detail: "Stub mode — no SMS sent. Use this code to log in.",
        }),
      );
      return;
    }

    await this.post(MSG91_OTP_URL, {
      template_id: this.config.MSG91_OTP_TEMPLATE_ID,
      mobile: phone.replace(/^\+/, ""),
      otp: code,
      sender: this.config.MSG91_SENDER_ID,
    });
  }

  /**
   * Send a templated message.
   *
   * `category` is recorded by the caller for auditing; the actual DND behaviour is
   * decided by how the template was registered on DLT, which is why the template id is
   * required rather than free text.
   */
  async sendTemplate(
    phone: string,
    templateId: string,
    variables: Record<string, string>,
    category: TemplateCategory,
  ): Promise<void> {
    if (this.config.smsIsStubbed) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({ event: "sms_stub_template", phone, templateId, category }),
      );
      return;
    }

    await this.post(MSG91_FLOW_URL, {
      template_id: templateId,
      sender: this.config.MSG91_SENDER_ID,
      recipients: [{ mobiles: phone.replace(/^\+/, ""), ...variables }],
    });
  }

  private async post(url: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authkey: this.config.MSG91_AUTH_KEY!,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Never log the body — it contains the OTP.
        throw new UpstreamError(
          "Could not send the verification code. Please try again.",
        );
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError("Could not send the verification code. Please try again.");
    } finally {
      clearTimeout(timeout);
    }
  }
}
