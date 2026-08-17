"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, ApiError, session } from "../../lib/api";

interface Membership {
  societyId: string;
  societyName: string;
  roles: string[];
}

/**
 * Sign in.
 *
 * Phone and a one-time code — no passwords. Committee membership turns over every year
 * and a shared password would outlive the committee that chose it.
 *
 * Two steps rather than one screen: a person may hold roles in more than one society
 * (an owner in A, on the committee in B), so the society is chosen after identity is
 * proven, not guessed beforehand.
 */
export default function SignIn() {
  const router = useRouter();
  const [stage, setStage] = useState<"phone" | "code" | "society">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (session.isSignedIn()) router.replace("/dashboard/");
  }, [router]);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/v1/auth/otp/request", { phone });
      setNotice("We have sent a 6-digit code to that number.");
      setStage("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Verify, then discover which societies this person belongs to.
   *
   * The first verify deliberately sends no societyId. The API refuses a session scoped
   * to a society the person is not a member of, so guessing one here would fail for a
   * legitimate user.
   */
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const tokens = await api.post<{ accessToken: string; refreshToken: string }>(
        "/v1/auth/otp/verify",
        { phone, code },
      );
      sessionStorage.setItem("wmg.access", tokens.accessToken);
      sessionStorage.setItem("wmg.refresh", tokens.refreshToken);

      const mine = await api.get<Membership[]>("/v1/auth/me/memberships");
      if (mine.length === 0) {
        session.clear();
        setError(
          "This number is not registered with any society yet. Ask your committee to add you.",
        );
        setStage("phone");
        return;
      }
      if (mine.length === 1) {
        await choose(mine[0]!);
        return;
      }
      setMemberships(mine);
      setStage("society");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That code did not work.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Exchange for a token scoped to one society.
   *
   * Re-verification is not needed — the refresh token proves the earlier OTP — but the
   * new token must carry the society, because every tenant-scoped endpoint reads the
   * society from the token rather than from the request.
   */
  async function choose(membership: Membership) {
    setBusy(true);
    try {
      const refreshToken = sessionStorage.getItem("wmg.refresh")!;
      const tokens = await api.post<{ accessToken: string; refreshToken: string }>(
        "/v1/auth/refresh",
        { refreshToken, societyId: membership.societyId },
      );
      // Roles are stored alongside the token so the console can decline to offer an
      // action that would certainly be refused. The API still checks every one of them.
      session.save(tokens, membership.societyId, {
        roles: membership.roles,
        societyName: membership.societyName,
      });
      router.replace("/dashboard/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open that society.");
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card settle">
        <h1>
          Watch<em>My</em>Gate
        </h1>
        <p className="lede">
          {stage === "phone"
            ? "Sign in with the mobile number your society has on record."
            : stage === "code"
              ? `Enter the code we sent to ${phone}.`
              : "Which society would you like to open?"}
        </p>

        {error ? (
          <div className="notice" data-tone="error">
            {error}
          </div>
        ) : null}
        {notice && !error ? (
          <div className="notice" data-tone="info">
            {notice}
          </div>
        ) : null}

        {stage === "phone" ? (
          <form onSubmit={requestCode}>
            <div className="field">
              <label htmlFor="phone">Mobile number</label>
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+91 99000 00001"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <button data-variant="primary" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : null}

        {stage === "code" ? (
          <form onSubmit={verify}>
            <div className="field">
              <label htmlFor="code">6-digit code</label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                style={{
                  fontFamily: "var(--font-figure)",
                  fontSize: "1.3rem",
                  letterSpacing: "0.4em",
                  textAlign: "center",
                }}
              />
            </div>
            <button data-variant="primary" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("phone");
                setCode("");
                setNotice("");
              }}
              style={{ width: "100%", marginTop: 8 }}
            >
              Use a different number
            </button>
          </form>
        ) : null}

        {stage === "society" ? (
          <div>
            {memberships.map((m) => (
              <button
                key={m.societyId}
                onClick={() => void choose(m)}
                disabled={busy}
                style={{ width: "100%", marginBottom: 8, textAlign: "left" }}
              >
                {m.societyName}
                <span className="muted" style={{ display: "block", fontWeight: 400 }}>
                  {m.roles.join(", ").replace(/_/g, " ")}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <p className="gate-back">
          <Link href="/">← About WatchMyGate</Link>
        </p>
      </div>
    </div>
  );
}
