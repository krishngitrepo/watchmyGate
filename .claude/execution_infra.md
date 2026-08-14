# Where the work runs

*Decided 30 July 2026. This is settled — read it before proposing a change to it.*

CareStock is developed on a **Ryzen 5 5500U laptop: 6 cores, 15 GB RAM, 15 W**. That is
an ultraportable chip in a thin chassis. Under an Android emulator plus Gradle plus the
WASM-Postgres test suites it thermally throttles and the machine hangs — repeatedly, to
the point of blocking work.

The response is not a faster laptop and not a cloud desktop. It is to stop doing heavy
work on that machine at all.

---

## The rule

> **Nothing compiles on the laptop. Its remaining job is a browser and a cable to a
> phone.**

| Job | Runs on | Cost |
|---|---|---|
| Writing code (Claude) | **claude.ai/code** — cloud sandbox on the GitHub repo | included in the Claude plan |
| Typecheck · 408 tests · Next build | **GitHub Actions** (`check` job) | free — 2,000 Linux min/month |
| Flutter APK | **GitHub Actions** (`apk` job) → downloadable artifact | free |
| Container image | **Cloud Build** | unchanged |
| Backend | **Cloud Run** `asia-southeast1` | unchanged |
| **Seeing the app** | **A real Android phone**, USB or wireless ADB | free |
| Play Store releases | **Codemagic** — *not yet; see the trigger below* | 500 min/month free |

Everything except the last two rows is already in place.

---

## The one thing that cannot move

**No cloud service gives you an Android emulator you can watch and tap.** That is the
constraint the whole plan bends around, and it is worth being precise about why, because
three plausible-looking options all fail on it:

- **GitHub Codespaces has no nested virtualisation.** `/dev/kvm` is unavailable, so an
  emulator there falls back to software rendering — *slower than the laptop it was
  meant to replace*. Its free tier is also a 2-core box, weaker than this machine for
  Gradle. It does not solve the problem it appears to solve.
- **AWS has no nested virtualisation** outside bare-metal instances.
- **Google Cloud's nested virtualisation supports Linux KVM only, not Hyper-V** — so a
  GCP *Windows* desktop cannot accelerate an emulator no matter how large it is.
- **Azure can** do Windows plus nested virtualisation, and its $200 credit expires in
  **30 days**. A rented desktop is therefore a one-month reprieve costing roughly
  $250–360/month afterwards, mostly Windows licensing, to replace something GitHub
  Actions does free and permanently.

Commercial device farms exist and are too thin to develop against: TestMu AI (formerly
LambdaTest) allows **3 native app sessions a month** on its free plan; BrowserStack App
Live gives **30 minutes**, once.

### So: a phone, and this is not a compromise

**A phone is not an emulator.** The emulator is a QEMU virtual machine holding several
vCPUs for hours; ADB to a handset is a file copy and a screen capture, at effectively no
CPU cost. Removing the emulator removes the heat. Keeping the phone adds none of it back.

It is also the better surface. Six serious defects in this app were invisible to
`flutter analyze` and to the entire unit suite, and obvious within seconds on hardware —
a release APK with no `INTERNET` permission, every new owner locked out at sign-in, a
cart pricing every line at ₹0.00, base64 written into a `uuid` column, a spinner that
never stopped, and a sale denied the cost column it is required to record. The unit
suite proves the rules; only the device proves the product.

---

## Rejected, with reasons — do not revisit without new facts

| Option | Verdict |
|---|---|
| **GitHub Codespaces** | No KVM; 2-core free tier is slower than the laptop for Gradle. Rejected. |
| **Gitpod** | Classic's pay-as-you-go sunset October 2025; rebranded to Ona, successor is self-hosted. Not a candidate. |
| **Expo / EAS** | **React Native only.** Verified on Expo's own site, against a search summary that wrongly claimed Flutter support. Adopting it would mean rewriting the Flutter app. Rejected. |
| **Cloud Windows desktop (RDP)** | Free tiers are all 1 GB RAM and cannot compile this project. Credits fund 1–3 months, then $250–360/month. The most expensive fix available. Rejected. |
| **Codemagic, today** | Duplicates the `apk` job for zero gain. *Deferred, not rejected* — see below. |

---

## Codemagic — the trigger

**Adopt when the Google Play developer account exists.** Not before: a second CI system
today means two configurations drifting apart to build the same debug APK.

What it will then be worth having, and what GitHub Actions makes harder:

1. **Upload keystore management.** Codemagic stores and applies it encrypted. On Actions
   the keystore is base64'd into a secret and the signing config wired by hand — this is
   the one key that cannot be replaced; lose or leak it and the app can never be updated.
2. **Direct publication to a Play Store track**, rather than fastlane as another moving
   part.
3. **iOS.** Building for iPhone requires macOS, and **GitHub bills macOS minutes at 10×**
   — 2,000 free minutes become 200. Codemagic is built around macOS for Flutter.

*Open question to settle at that point, not now: exactly which instance types Codemagic's
free 500 minutes cover. Do not plan around an assumption here.*

---

## Emulator tests in CI — possible, deliberately not built

GitHub's **x86 runners do expose `/dev/kvm`**, so `reactivecircus/android-emulator-runner`
would work. It is still not worth adding, and the reason matters more than the conclusion:

`apps/mobile/integration_test/app_test.dart` assumes a device that is **already signed
in** — the session lives in the Android Keystore, and login runs an MSG91 OTP widget in a
WebView. On a fresh CI emulator every test would find the login screen and skip, and the
job would report green having proved nothing.

That is precisely the failure this repository keeps meeting: a green Cloud Build that
deployed nothing; `db:verify` made entirely of refusal assertions, passing while the
application itself was locked out; 249 service tests green because PGlite runs as the
owning role. **A green signal that cannot fail is worse than no signal**, because it is
believed. Build this only alongside a way to seed an authenticated session.

---

## Working agreement

1. **Push before switching machines.** A cloud sandbox clones from GitHub; anything
   uncommitted on the laptop does not exist as far as it is concerned.
2. **Read the APK from the Actions artifact** (`carestock-debug-apk`, 14-day retention)
   rather than building locally.
3. **A green Actions run is not a deploy.** `cloudbuild.yaml` builds and pushes only;
   `gcloud run deploy` is separate, and the live revision must be read back afterwards.
   This has already caused one silent non-deploy reported as shipped.
4. **Budget alarms before any cloud VM**, if that decision is ever revisited. A forgotten
   4-vCPU instance at $0.40/hour is roughly $290 a month.
