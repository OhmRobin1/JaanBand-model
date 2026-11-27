# JaanBand Core MK-IV & JaanShield Security Specification

## Data Invariants
1. **Identity & Ownership**: Every `workers/{workerId}` document must belong to a verified Firebase Auth user (`ownerUid == request.auth.uid`) or a verified administrator (`dancerohmrobin@gmail.com` or `admins/{uid}`). Unauthenticated or unverified users cannot read, list, create, update, or delete any worker or telemetry document.
2. **Master Gate Relational Sync**: A `workers/{workerId}/telemetry/{reportId}` document cannot exist without a valid parent `workers/{workerId}` owned by the same operator (`get(...)`), and telemetry ingestion must atomically update the parent worker's `updatedAt` in the same batch (`getAfter(...)`).
3. **Zero Shadow Fields & Strict Typing**: Every document key is allowlisted (`hasAll` + `hasOnly`), strings are bounded by `.size()`, numbers are bounded by physiological limits (`bpm` 25–240, `spo2` 50–100, `skinTempC` 25–45), and document IDs must match `^[a-zA-Z0-9_\-]+$`.
4. **Immutable Audit Fields & Server Timestamps**: `id`, `ownerUid`, and `createdAt` are immutable after creation; `createdAt` and `updatedAt` must equal `request.time`.
5. **No Blanket List Scraping**: List queries enforce `resource.data.ownerUid == request.auth.uid || isAdmin()` directly in the rule without `get()`/`exists()` reads.

## The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: `request.auth == null` reading `/workers/W01` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: `request.auth.token.email_verified == false` creating `/workers/W01` -> `PERMISSION_DENIED`.
3. **Owner Spoofing on Create**: User A sets `ownerUid: "user-B"` in `/workers/W01` -> `PERMISSION_DENIED`.
4. **Owner Hijack on Update**: User A updates `/workers/W01` trying to change `ownerUid` -> `PERMISSION_DENIED`.
5. **Shadow Ghost Field Injection**: User creates `/workers/W01` with extra key `isAdmin: true` -> `PERMISSION_DENIED`.
6. **ID Poisoning**: Document path `/workers/W01;DROP_TABLE` or 200-char ID -> `PERMISSION_DENIED`.
7. **Client Timestamp Forgery**: `createdAt` or `updatedAt` set to past client timestamp instead of `request.time` -> `PERMISSION_DENIED`.
8. **Out-of-Bounds Physiology Poisoning**: Telemetry packet with `bpm: 999` or `spo2: 150` -> `PERMISSION_DENIED`.
9. **Unbounded Array / Reasons Flooding**: `reasons` array of 25 strings or 5KB first string -> `PERMISSION_DENIED`.
10. **Orphaned Telemetry Report**: Creating `/workers/NONEXISTENT/telemetry/R1` without parent worker -> `PERMISSION_DENIED`.
11. **Non-Atomic Telemetry Desync**: Creating `/workers/W01/telemetry/R1` without updating parent worker `updatedAt == request.time` in the same batch -> `PERMISSION_DENIED`.
12. **Blanket List Scrape Across Tenants**: User B calling `list` on `/workers` without `where('ownerUid', '==', B.uid)` -> `PERMISSION_DENIED`.
