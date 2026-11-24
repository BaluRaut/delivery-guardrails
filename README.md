# Delivery guardrails

GitHub Actions that keep pull requests small and moving, for a team that wants to deliver quickly without a manager chasing people.

**Site:** https://baluraut.github.io/delivery-guardrails/

| Guardrail | What it does | Blocks merging? |
|---|---|---|
| **PR rules** | Fails a pull request that changes more than 500 lines, or whose work started more than 8 working hours ago | Yes, once its checks are required |
| **Delivery alerts** | One Slack message about stuck work: pull requests open more than 6 working hours, grouped by who must act; merged work not on UAT after 7 working hours; a failed UAT deployment; repos with no UAT deployments recorded | No, it only alerts |

## Working hours, not clock hours

Ages count only working time: by default 09:00–18:00 IST, Monday to Friday, skipping any holidays you list.

- A pull request opened at **4pm** gets **2 hours** that day, and the clock resumes at 9am the next working day.
- Friday 5pm to Monday 10am is **2 hours**.
- Saturday, Sunday, nights and holidays add nothing.

Set `AGE_CLOCK=calendar` to count every hour instead.

## Set up PR rules (in each repo)

1. **Copy** [`templates/pr-rules.yml`](templates/pr-rules.yml) to `.github/workflows/pr-rules.yml` on the repo's default branch.
2. **Create the exception labels:**

   ```sh
   gh label create size-exception --color FBCA04 --description "Allowed over the line limit; tech lead approved"
   gh label create age-exception  --color FBCA04 --description "Allowed over the age limit; tech lead approved"
   ```

3. **Open any pull request**, so the two checks report once. GitHub only offers a check as "required" after it has seen it.
4. **Make the checks required:**
   1. Go to Settings → Rules → Rulesets → New branch ruleset.
   2. Target the default branch.
   3. Turn on **Require status checks to pass** and add `pr-rules/size` and `pr-rules/age`.
   4. Set enforcement to **Active**.

   Or run:

   ```sh
   gh api -X POST "repos/{owner}/{repo}/rulesets" --input - <<'JSON'
   {
     "name": "PR rules required",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "rules": [
       { "type": "required_status_checks", "parameters": {
         "strict_required_status_checks_policy": false,
         "required_status_checks": [ { "context": "pr-rules/size" }, { "context": "pr-rules/age" } ] } }
     ]
   }
   JSON
   ```

A failing pull request shows a red check with the reason, for example *"612 lines changed. Split it into PRs under 500 lines."*, and the merge button stays locked. The tech lead can allow a justified exception with the `size-exception` or `age-exception` label: a migration, a large rename, generated code or an emergency fix.

## Set up delivery alerts (once, in one repo)

1. **Copy** [`templates/delivery-alerts.yml`](templates/delivery-alerts.yml) to `.github/workflows/delivery-alerts.yml` in any one of your team's repos.
2. **List your team's repos:** `gh variable set TEAM_REPOS --body "your-org/orders-api your-org/orders-web"`.
3. **Add a read-only token:**
   1. Create a fine-grained token with access to only those repos.
   2. Give it read-only *Pull requests*, *Deployments* and *Contents*.
   3. Save it as the secret `TEAM_READ_TOKEN`.

   If you only watch the repo the workflow lives in, you can skip this step.
4. **Connect Slack:** create an incoming webhook for the team channel and save it as the secret `SLACK_WEBHOOK`. Until you do, the message only appears in the run log and summary, which works as a dry run.
5. **Record UAT deployments:** see the next section.
6. **Run it once** from the Actions tab with **Run workflow**. After that it runs hourly on weekdays, 09:30–18:30 IST.

### Recording UAT deployments

The alerts read GitHub's deployment records for the environment `uat`; change the name with `UAT_ENVIRONMENT`.

- **GitHub Actions deploys:** give the UAT job `environment: uat`, and every deployment is recorded automatically.
- **Jenkins, Argo CD, Octopus or similar:** add this after each UAT deploy, with `state=failure` when it fails:

  ```sh
  id=$(gh api -X POST "repos/$REPO/deployments" --input - --jq .id <<JSON
  {"ref": "$DEPLOYED_SHA", "environment": "uat", "auto_merge": false, "required_contexts": []}
  JSON
  )
  gh api -X POST "repos/$REPO/deployments/$id/statuses" -f state=success
  ```

A merged pull request counts as on UAT when the latest successful UAT deployment contains its merge commit.

### What the Slack message looks like

An example, with pull request names made up:

```text
Pull requests open more than 6 working hours
  Waiting for a first review (reviewers to act)
  • orders-api#412 Add cancel button · 7.5h · by @asha · @ravi
  Changes requested (author to act)
  • orders-web#88 Refund banner · 9h · by @meera · @meera

Merged but not on uat after 7 working hours
• orders-api#405 Retry refunds · merged 8h ago

Latest uat deployment failed
• refund-worker: deployment of 3f2a9c1 failed 1h ago
```

Each stuck pull request lands in one of four stages, so the right people act:
- waiting for a first review;
- reviewed, waiting for approval;
- changes requested;
- approved but not merged.

## Settings

Set these as repository variables (Settings → Secrets and variables → Actions → Variables). Anything unset uses the default.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `MAX_LINES` | `500` | PR rules | Most changed lines in one pull request |
| `MAX_AGE_HOURS` | `8` | PR rules | Most hours since the work started before merging is blocked |
| `AGE_FROM` | `oldest-commit` | PR rules | `oldest-commit`, or `pr-opened` for a clock nobody can change |
| `IGNORE_PATHS` | lock files, `.snap`, `generated/` | PR rules | Regular expression for files that don't count towards `MAX_LINES` |
| `TEAM_REPOS` | this repo | Alerts | Space-separated `owner/repo` list |
| `MAX_PR_HOURS` | `6` | Alerts | Alert on pull requests open longer than this; set it below `MAX_AGE_HOURS` so the alert comes first |
| `MAX_UAT_HOURS` | `7` | Alerts | Alert on merged pull requests not on UAT after this |
| `UAT_ENVIRONMENT` | `uat` | Alerts | Deployment environment name |
| `AGE_CLOCK` | `working` | Both | `working` or `calendar` |
| `WORK_TIMEZONE` | `Asia/Kolkata` | Both | Any IANA time zone, for example `Europe/London` |
| `WORK_START` / `WORK_END` | `09:00` / `18:00` | Both | Working hours, 24-hour clock |
| `WORK_DAYS` | `Mon,Tue,Wed,Thu,Fri` | Both | Working days |
| `HOLIDAYS` | none | Both | Dates to skip, for example `2026-12-25,2027-01-26` |

| Secret | Needed for |
|---|---|
| `SLACK_WEBHOOK` | Sending alerts to Slack |
| `TEAM_READ_TOKEN` | Watching repos other than the one the alerts workflow lives in |

The schedules in the templates run during IST working hours. If you change the time zone or use the calendar clock, change their `cron` lines too; cron times are in UTC.

## How it works

```text
GitHub Actions (on a pull request, or hourly)
  └─ fetches the scripts from this repo at a pinned release (v2.0.0)
      └─ node scripts/pr-rules.mjs        → GitHub API → pr-rules/size and pr-rules/age checks
      └─ node scripts/delivery-alerts.mjs → GitHub API → one Slack message
```

The scripts have no dependencies and use only the GitHub REST API, following every page of results. Your workflows pin a release tag, so an update here doesn't change your checks until you move the tag. For the strictest setup, pin a commit SHA.

## What it doesn't measure

- **Individual performance.** It reports stuck work, not people. Don't turn alerts into rankings, and don't measure "pull requests per developer".
- **Quality.** A small, fast pull request can still be wrong. Code review and tests stay essential.
- **Work outside pull requests.** Commits pushed straight to the default branch, design work and support aren't counted.
- **Production.** It stops at UAT. Track production with your DORA metrics.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pr-rules/size` isn't offered when adding a required check | The checks haven't reported yet. Open a pull request first. |
| Checks never appear on pull requests from forks | The built-in token is read-only for forks, so statuses can't be posted. Work in branches of the same repo. |
| A repo shows under "No uat deployments recorded" | No successful deployment with that environment name. Check the name, and that your pipeline records deployments. |
| A merged pull request never shows as late | It was merged more than 14 days ago, or it was pushed without a pull request. |
| `GitHub GET … returned 404` in the alerts run | `TEAM_READ_TOKEN` can't see that repo. Add the repo to the token. |
| `Slack returned 404: no_service` | The webhook was removed or mistyped. Create a new one and update the secret. |
| `WORK_START must look like 09:00` | Use 24-hour `HH:MM`. |
| The age check doesn't turn red overnight | Expected: the working clock doesn't move outside working hours. |

## Rolling it out

| Week | Step |
|---|---|
| 1 | Install both workflows on one squad's repos. Make the size check required; leave the age check visible but not required. |
| 2 | Watch the alerts and how often pull requests cross the limits. Adjust `IGNORE_PATHS` and the hours. |
| 3 | Connect Slack, and agree who acts on each alert stage. |
| 4 | Review the numbers with the team, then make `pr-rules/age` required too. |

## Limits

- Pull requests with more than 3,000 files are only partly read by the GitHub API; the line count then includes every file, so the check errs on the strict side.
- Only the first 250 commits of a pull request are read for the age. It's unusual to hit this limit.
- Scheduled runs can start a few minutes late. In public repos, GitHub pauses schedules after 60 days with no activity.

## Tested

v2 was tested on GitHub in this repo on 24 November 2026; the test pull requests, deployments and settings were removed afterwards.

| Test | Result |
|---|---|
| This release's own pull request, 1,282 lines | `pr-rules/size` failed; with `size-exception` it passed: "1282 lines changed; allowed by the size-exception label" |
| Commit dated Friday 16:00 IST, checked Tuesday 12:37 IST | `pr-rules/age` failed at **14.6 working hours**: Friday 2h + Monday 9h + Tuesday 3.6h |
| Delivery alerts, limits set to 0, UAT on an old commit with a newer failed deployment, plus a second repo with no UAT records | One message listing both open pull requests under "waiting for a first review", 3 merged pull requests not on UAT, the failed deployment, and the repo with no records |
| 23 automated tests, run by CI on every pull request | Pass. They cover the clock (weekends, holidays, a daylight-saving change), the checks, the four stages, paging through 151 files, and Slack messages and errors against a fake Slack server |

The earlier version showed the ruleset blocking a failing pull request from merging. v2 posts the same two checks.

A real Slack webhook hasn't been tested yet, because this repo has none. Add your webhook and click **Run workflow** once to confirm.

## Development

```text
scripts/lib.mjs              settings, working-hours clock, GitHub client, Slack
scripts/pr-rules.mjs         the size and age checks
scripts/delivery-alerts.mjs  the alert message
templates/                   workflows for teams to copy
test/                        unit and end-to-end tests against fake GitHub and Slack servers
```

Run the tests with `node --test test/*.test.mjs` (Node 20 or later). CI runs them on every pull request. The workflows in `.github/workflows/` run this repo's own code, so changes are tried here before they're released as a new tag.
