# Judge0 — self-hosted execution cluster

The sandbox that runs candidate code for Exam Forge coding items. This directory
is the deployment; the client is `functions/src/judge0Adapter.ts`, reached
through the `JudgeAdapter` interface so nothing above it knows Judge0 exists.

> **Judge0 executes arbitrary untrusted code as its purpose.** Every decision
> here follows from that. If you are changing something and the reason is
> convenience, the answer is probably no.

---

## 1 · Architecture

```
Cloud Functions (scheduledJudgeCoding)
        │  private IP, X-Auth-Token
        │  Serverless VPC Access connector
        ▼
   ┌────────────────────────────────────────────┐
   │ judge0-host (dedicated VM, private subnet) │
   │                                            │
   │   server ──── redis ──── workers ×N        │
   │      └─────── postgres ─────┘              │
   │                                            │
   │   workers: judge0-internal only (no route  │
   │            off the host, no gateway)       │
   └────────────────────────────────────────────┘
```

**Nothing about this is reachable from the internet.** The API binds to
`127.0.0.1:2358`; the VPC connector is the only route in, and it carries a
token. Public Judge0 instances get found and mined on within hours — this is a
well-documented outcome, not a hypothetical.

**Workers have no network at all.** They sit on a Docker network declared
`internal: true`, which removes the gateway rather than filtering it, and every
submission also carries `enable_network: false`. Two independent mechanisms,
because a candidate program with network access could exfiltrate the paper.

Workers run `privileged: true` because `isolate` needs cgroup and namespace
control to enforce the limits that stop one submission taking the host down.
That is exactly why they belong on a **dedicated VM** that runs nothing else —
never on a host shared with application workloads.

---

## 2 · Provisioning

**Host sizing.** Start with 8 vCPU / 16 GB and 4 worker replicas. The real
constraint is worker count, and the useful rule is that **worker replicas should
not exceed physical cores minus two** — the two are for the API and Postgres.
Oversubscribing does not raise throughput; it makes wall-clock limits fire on
submissions that were merely waiting for a core, which shows up as candidates
failing tests they actually passed.

```bash
# On the judge host
git clone <this repo> && cd infra/judge0

# Secrets. .env.judge0 is git-ignored — never commit it.
cat > .env.judge0 <<'EOF'
POSTGRES_DB=judge0
POSTGRES_USER=judge0
POSTGRES_PASSWORD=<openssl rand -base64 32>
REDIS_PASSWORD=<openssl rand -base64 32>
AUTHN_TOKEN=<openssl rand -base64 48>
EOF
chmod 600 .env.judge0

# isolate needs these on the host, not in the container
sudo sysctl -w kernel.perf_event_paranoid=1
echo 'kernel.perf_event_paranoid=1' | sudo tee /etc/sysctl.d/99-judge0.conf

docker compose up -d
docker compose ps            # all healthy before proceeding
```

### cgroup v2 — expect this to be the first thing that breaks

Judge0 1.13.x's `isolate` requires **cgroup v1**, and every current distro
(Ubuntu 22.04+, Debian 12, most GCP images) boots cgroup v2 by default. The
symptom is not a clear error: workers start, accept submissions, and every one
comes back as an internal error or with its limits silently unenforced — which
is the worst failure mode this cluster has, because unenforced limits look like
a working judge until a candidate submits an infinite loop.

```bash
# Check which hierarchy the host is on
stat -fc %T /sys/fs/cgroup    # cgroup2fs = v2, tmpfs = v1

# If v2, switch the host and reboot
sudo sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 systemd.unified_cgroup_hierarchy=0"/' /etc/default/grub
sudo update-grub && sudo reboot
```

`verify.mjs` catches this — V-07 through V-10 fail if limits are not being
enforced — which is the reason to run it before pointing an exam at the cluster
rather than after.

**Verify before sending it real work.** One command, and it is a gate rather
than a checklist:

```bash
JUDGE0_URL=http://127.0.0.1:2358 AUTHN_TOKEN=<token> npm run verify:judge0
```

`infra/judge0/verify.mjs` is the only thing in this project that tests the
sandbox itself. Everything else — limits, comparison, the adapter's failure
handling — is proven against fakes, which cannot tell you whether isolate
actually kills an infinite loop or whether a candidate can open a socket.

It exits non-zero on any failure, so it belongs in front of a deploy, not
beside it. It checks:

| | |
|---|---|
| V-01/02 | The cluster answers, and **refuses an unauthenticated request** |
| V-03 | The pinned language ids match this instance |
| V-04..06 | Code runs, compile errors are reported, stderr stays separate from stdout |
| V-07..10 | CPU, wall, memory and process limits are actually enforced |
| **V-11/12** | **A submission cannot open a socket or resolve a hostname** |
| V-13 | The server accepts a submission at the platform ceiling |

V-11 and V-12 are the ones to care about. A program that can reach the network
can exfiltrate the paper and fetch an answer; the script tests that *property*
rather than either mechanism that is supposed to provide it.

Two checks still need shell access on the host and cannot be done over HTTP:

```bash
# Must FAIL — a worker that can reach the internet is a broken deployment.
docker compose exec workers curl -m 5 https://example.com ; echo "exit=$?"

# Must fail from anywhere that is not the host.
curl -m 5 http://<host-ip>:2358/system_info
```

---

## 3 · Connecting the platform

```bash
# The private address the VPC connector can reach, and the token.
firebase functions:config:unset judge0 2>/dev/null || true
firebase deploy --only functions \
  --set-env-vars JUDGE0_BASE_URL=http://10.x.x.x:2358

echo -n '<AUTHN_TOKEN>' | firebase functions:secrets:set JUDGE0_AUTH_TOKEN
```

Both are optional by design:

| `JUDGE0_BASE_URL` | `JUDGE0_AUTH_TOKEN` | Behaviour |
|---|---|---|
| unset | — | `NullJudgeAdapter` — papers queue and await review, never scored zero |
| set | unset | **Refused.** An unauthenticated judge is worse than none; logged loudly, falls back to `NullJudgeAdapter` |
| set | set | `Judge0Adapter` |

Losing the configuration degrades to "marks are owed", never to "everyone
failed". That is the same rule the whole subsystem is built on.

---

## 4 · After every upgrade: check the language table

**Judge0's numeric language ids change between releases.** `JUDGE0_LANGUAGE_IDS`
is pinned to the image tag in `docker-compose.yml`. An upgrade that renumbers
them does not error — it runs Python submissions as Ruby, and every candidate
looks like they wrote broken code.

`npm run verify:judge0` covers this as check V-03 — run the whole script after
an upgrade rather than this one thing, since a Judge0 release can move more
than the ids.

Run it as a deployment gate, not by hand when someone remembers.

---

## 5 · Operating it

**Scaling.** `docker compose up -d --scale workers=N`, subject to the cores rule
above. Worker count is the platform's concurrency ceiling: a cohort of 200
submitting at once queues against N, and the sweep drains the backlog across
runs rather than timing out — which is why the queue is allowed to build.

**Backpressure.** `MAX_QUEUE_SIZE=2000` in `judge0.conf`. Past it Judge0 rejects
new submissions; the adapter reports that as unavailable and the sweep retries
with backoff. Rejection is the correct behaviour — accepting unbounded work
during an exam converts a slow judge into a dead one.

**What to watch.**

| Signal | Where | Meaning |
|---|---|---|
| Queue depth | `redis-cli -a $REDIS_PASSWORD llen judge0_default` | Sustained growth = under-provisioned workers |
| `judge_unavailable` verdicts | `attemptVerdicts` `state.lastStatus` | Cluster trouble; check before students report it |
| Exhausted submissions | `state.attempts >= 5` | Gave up. A human owes those papers a mark |
| Pending papers | `attempts` where `codeJudgePending == true` | Should trend to zero between exams |

**Submission retention.** Candidate source is personal data, and the platform
has its own erasure machinery. Judge0 must not become a second unmanaged copy:
the authoritative record of what a candidate wrote is the attempt document, and
the verdict lives in `attemptVerdicts`. Purge Judge0's own store on a schedule.

```bash
# Cron, daily. Judge0 keeps submissions indefinitely otherwise.
docker compose exec -T db psql -U judge0 -d judge0 \
  -c "DELETE FROM submissions WHERE created_at < now() - interval '7 days';"
```

**Backups: deliberately none.** There is nothing here worth restoring. Postgres
holds in-flight submissions whose verdicts are already written to Firestore, and
a rebuilt cluster with an empty database is fully correct — the sweep re-judges
anything still pending. Backing it up would only create another copy of
candidate code to protect.

---

## 6 · Failure modes, and what each one does

| Failure | What happens | Student impact |
|---|---|---|
| Cluster down | Adapter returns `judge_unavailable`; breaker opens after 5 consecutive failures and fails fast | None during the exam. Papers queue, marks arrive late |
| Cluster down at submit | Submitting **never** waits on the judge | None |
| Slow / queue backed up | Run deadline (120s) expires, retried with escalating backoff | Marks arrive late |
| Down beyond 5 retries | Submission marked exhausted, paper stays in manual review | Needs a human, and is visible as needing one |
| Wrong language ids | Everything "fails" plausibly | **Severe and silent** — this is why §4 is a gate |
| Token leaked | Anyone reaching the VPC can execute code | Rotate `AUTHN_TOKEN`, redeploy, restart the cluster |

The first four are all the same shape on purpose: **a judge failure is never a
candidate's zero.** It is enforced in `judgeCore.outcomeFor`, asserted by
`judge.suite` J-16 and `audit.grading` G-13/G-18, and this deployment is built so
the infrastructure cannot violate it either.
