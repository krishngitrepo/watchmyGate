/**
 * Cloudflare R2 object storage.
 *
 * Two rules carry the tenant boundary into the object store:
 *
 * 1. **Every key is prefixed with the society id.** A signed URL therefore proves which
 *    society an object belongs to, and a listing cannot span tenants even if a query is
 *    wrong.
 * 2. **Nothing is public.** Access is always a short-lived presigned URL. Uploads are
 *    presigned too, so photo bytes go from the resident's phone straight to R2 and
 *    never through the API — which matters at roughly 2M gate photos a day.
 *
 * Cross-society access returns 404, never 403: confirming an object exists is itself a
 * disclosure.
 */

import { createHmac } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { loadConfig } from "./config.js";
import { NotFoundError, ValidationError } from "./errors.js";

export type AttachmentKind = "photo" | "video" | "voice" | "document";

/** Deliberately narrow — anything unlisted is rejected at the boundary. */
const ALLOWED: Record<string, AttachmentKind> = {
  "image/jpeg": "photo",
  "image/png": "photo",
  "image/webp": "photo",
  "image/heic": "photo",
  "video/mp4": "video",
  "video/quicktime": "video",
  "audio/mpeg": "voice",
  "audio/mp4": "voice",
  "audio/ogg": "voice",
  "audio/webm": "voice",
  "application/pdf": "document",
};

const MAX_BYTES: Record<AttachmentKind, number> = {
  photo: 15 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  voice: 10 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

export const UPLOAD_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_TTL_SECONDS = 10 * 60;

@Injectable()
export class StorageService {
  private readonly config = loadConfig();

  classify(contentType: string): AttachmentKind {
    const kind = ALLOWED[contentType.toLowerCase().split(";")[0]!.trim()];
    if (!kind) {
      throw new ValidationError(`Files of type ${contentType} are not accepted.`);
    }
    return kind;
  }

  /** The society prefix is the tenant boundary in the object store. */
  buildKey(
    societyId: string,
    ownerType: string,
    ownerId: string,
    kind: AttachmentKind,
  ): string {
    const stamp = new Date().toISOString().slice(0, 7).replace("-", "/");
    const random = crypto.randomUUID().replace(/-/g, "");
    return `societies/${societyId}/${ownerType}/${stamp}/${ownerId}/${kind}/${random}`;
  }

  /**
   * Guards every download against the caller's society.
   *
   * RLS protects the database row; this protects the object itself, so a leaked or
   * guessed key cannot be redeemed by a member of another society.
   */
  keyBelongsTo(key: string, societyId: string): boolean {
    return key.startsWith(`societies/${societyId}/`);
  }

  presignUpload(
    societyId: string,
    ownerType: string,
    ownerId: string,
    contentType: string,
    contentLength: number,
  ): { objectKey: string; uploadUrl: string; expiresIn: number } {
    const kind = this.classify(contentType);
    const limit = MAX_BYTES[kind];

    if (contentLength <= 0) {
      throw new ValidationError("Empty files cannot be uploaded.");
    }
    if (contentLength > limit) {
      throw new ValidationError(
        `That ${kind} is too large. The limit is ${Math.floor(limit / 1024 / 1024)} MB.`,
      );
    }

    const objectKey = this.buildKey(societyId, ownerType, ownerId, kind);

    if (this.config.storageIsStubbed) {
      return {
        objectKey,
        uploadUrl: `https://stub.local/upload/${encodeURIComponent(objectKey)}`,
        expiresIn: UPLOAD_TTL_SECONDS,
      };
    }

    const expires = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    return {
      objectKey,
      uploadUrl: this.sign("PUT", objectKey, expires, contentType),
      expiresIn: UPLOAD_TTL_SECONDS,
    };
  }

  presignDownload(key: string, societyId: string): string {
    if (!this.keyBelongsTo(key, societyId)) {
      // 404, not 403 — do not confirm that the object exists.
      throw new NotFoundError("File not found.");
    }

    if (this.config.storageIsStubbed) {
      return `https://stub.local/download/${encodeURIComponent(key)}`;
    }

    const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
    return this.sign("GET", key, expires);
  }

  private sign(
    method: string,
    key: string,
    expires: number,
    contentType?: string,
  ): string {
    const host =
      this.config.R2_PUBLIC_HOST ??
      `${this.config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

    const payload = [method, key, String(expires), contentType ?? ""].join("\n");
    const signature = createHmac("sha256", this.config.R2_SECRET_ACCESS_KEY!)
      .update(payload)
      .digest("hex");

    const params = new URLSearchParams({
      "X-Amz-Expires": String(expires),
      "X-Amz-Credential": this.config.R2_ACCESS_KEY_ID!,
      "X-Amz-Signature": signature,
    });

    return `https://${host}/${this.config.R2_BUCKET}/${key}?${params.toString()}`;
  }
}
