# Delivery guardrails

Two GitHub Actions workflows for a team that wants small pull requests that merge and deploy quickly.

| Workflow | What it does | Blocks merging? |
|---|---|---|
| [`pr-rules.yml`](.github/workflows/pr-rules.yml) | Fails a pull request that changes more than 500 lines, or whose work started more than 8 hours ago | Yes, once you make its checks required |
| [`delivery-alerts.yml`](.github/workflows/delivery-alerts.yml) | Posts to Slack when a pull request has been open more than 7 hours, or a merged pull request hasn't reached UAT within 7 hours | No, it only alerts |

All limits are settings, so you can change them without editing the YAML.

## 1. Block big or old pull requests

Do this in each repo you want to protect.

1. **Copy the workflow.** Add [`.github/workflows/pr-rules.yml`](.github/workflows/pr-rules.yml) to the repo's default branch. The hourly re-check only runs from the default branch.

2. **Create the exception labels:**

   ```sh
   gh label create size-exception --color FBCA04 --description "Allowed over the line limit; tech lead approved"
   gh label create age-exception  --color FBCA04 --description "Allowed over the age limit; tech lead approved"
   ```

3. **Open any pull request** so the two checks report once. GitHub only lists a check as "required" after it has seen it.

4. **Make the checks required.** Go to Settings → Rules → Rulesets → New branch ruleset:
   - Target: the default branch.
   - Turn on **Require status checks to pass** and add `pr-rules/size` and `pr-rules/age`.
   - Set enforcement to **Active** and save.

   Or with the GitHub CLI, from the repo folder:

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

A failing pull request now shows a red check with the reason, for example *"600 lines changed. Split it into PRs under 500 lines."*, and the merge button stays locked.

### How the checks decide

- **Size (`pr-rules/size`)** counts lines added plus lines removed. Lock files, Jest snapshots and anything under a `generated/` folder don't count.
- **Age (`pr-rules/age`)** measures from the oldest commit in the pull request, or from when the pull request was opened if you set `AGE_FROM` to `pr-opened`. Age grows with no new push, so the workflow re-checks every open pull request each hour. A pull request turns red within about an hour of passing the limit.
- **Exceptions:** the `size-exception` and `age-exception` labels turn the matching check green, and say so in the check. Use them for database migrations, large renames, generated code and emergency fixes. Agree that only the tech lead adds them; GitHub can't restrict who adds a label.

## 2. Alert on stuck work

Do this once, in any one of your team's repos.

1. **Copy the workflow.** Add [`.github/workflows/delivery-alerts.yml`](.github/workflows/delivery-alerts.yml) to that repo's default branch.

2. **List your team's repos** in a repository variable, under Settings → Secrets and variables → Actions → Variables:

   ```sh
   gh variable set TEAM_REPOS --body "your-org/orders-api your-org/orders-web your-org/refund-worker"
   ```

3. **Create a token that can read those repos:**
   1. Go to GitHub → Settings → Developer settings → Fine-grained tokens.
   2. Under repository access, choose only your team's repos.
   3. Give read-only access to Pull requests, Deployments and Contents.
   4. Save it as the secret `TEAM_READ_TOKEN`.

   If the workflow only watches its own repo, you can skip this step; it falls back to the built-in token.

4. **Create a Slack incoming webhook** for your team channel (Slack → Apps → Incoming Webhooks) and save it as the secret `SLACK_WEBHOOK`. Until you do, the alerts only appear in the run log and the run summary, which is handy for a dry run.

5. **Record UAT deployments** (see below), then run the workflow once from the Actions tab with **Run workflow**.

It runs hourly, Monday to Friday, 08:30–18:30 IST. To change that, edit the `cron` line; cron times are in UTC.

### How the UAT alert knows what's on UAT

It reads GitHub's deployment records for the environment named `uat` (change it with `UAT_ENVIRONMENT`). The commit on UAT is the newest deployment whose latest status is *success*. A merged pull request counts as deployed when that commit contains its merge commit.

- **Deploying with GitHub Actions:** give the deploy job `environment: uat`, and GitHub records every deployment for you.
- **Deploying with Jenkins, Argo CD, Octopus or similar:** add one step after a successful UAT deploy:

  ```sh
  id=$(gh api -X POST "repos/$REPO/deployments" --input - --jq .id <<JSON
  {"ref": "$DEPLOYED_SHA", "environment": "uat", "auto_merge": false, "required_contexts": []}
  JSON
  )
  gh api -X POST "repos/$REPO/deployments/$id/statuses" -f state=success
  ```

Repos with no successful UAT deployment recorded are skipped, and the run log says so.

## Settings

Set these as repository variables (Settings → Secrets and variables → Actions → Variables). Anything you don't set uses the default.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `MAX_LINES` | `500` | PR rules | Most changed lines allowed in one pull request |
| `MAX_AGE_HOURS` | `8` | PR rules | Most hours allowed since the work started |
| `AGE_FROM` | `oldest-commit` | PR rules | `oldest-commit`, or `pr-opened` for a clock nobody can change |
| `IGNORE_PATHS` | lock files, `.snap`, `generated/` | PR rules | Regular expression for files that don't count towards `MAX_LINES` |
| `TEAM_REPOS` | this repo | Alerts | Space-separated `owner/repo` list |
| `MAX_PR_HOURS` | `7` | Alerts | Alert on pull requests open longer than this |
| `MAX_UAT_HOURS` | `7` | Alerts | Alert on merged pull requests not on UAT after this |
| `UAT_ENVIRONMENT` | `uat` | Alerts | Deployment environment name to watch |

| Secret | Needed for |
|---|---|
| `SLACK_WEBHOOK` | Sending alerts to Slack |
| `TEAM_READ_TOKEN` | Watching repos other than the one the workflow lives in |

## What to know before switching on the age rule

- **Clock hours include nights and weekends.** Work started at 5pm and opened as a pull request the next morning is already 16 hours old. Consider 24 hours, or start with the age rule as a Slack alert only.
- **The author can't fix a slow review.** A pull request waiting on reviewers still turns red at hour 8. Many teams block on size, which the author controls, and alert on age so reviewers act.
- **Commit dates can be changed** with `git commit --amend --reset-author`. Set `AGE_FROM=pr-opened` if that matters.

A sensible rollout:

1. Turn on the 500-line block.
2. Run the age limit as an alert for 2–3 weeks.
3. Make it blocking once most pull requests already merge in time.

## Limits

- **Forked pull requests can't be checked.** The built-in token is read-only on pull requests from forks, so the checks can't post. Teams working in one repo aren't affected.
- **Ignored files are only spotted in the first 100 files** of a pull request. Beyond that they count towards the limit, so the check only errs on the strict side.
- **Commits pushed straight to the default branch,** without a pull request, aren't covered by the UAT alert.
- **Scheduled runs can start a few minutes late.** In public repos, GitHub pauses schedules after 60 days with no activity.

## Tested

Both workflows were tested in this repo on 2026-11-24, with a ruleset requiring both checks. The test pull requests and deployments were removed afterwards.

| Test | Result |
|---|---|
| Pull request changing 600 lines | `pr-rules/size` failed: "600 lines changed. Split it into PRs under 500 lines." Merge blocked. |
| Pull request whose commit was dated 10 hours earlier | `pr-rules/age` failed: "Started 10h ago. Merge or split work within 8h." Merge blocked. |
| `size-exception` label added to the 600-line pull request | Check turned green ("allowed by the size-exception label"); pull request became mergeable |
| Manual run of the hourly re-check | Re-evaluated all three open pull requests with the same results |
| Delivery alerts, both limits set to 0 hours, UAT on an older commit | Listed both open pull requests, and the merged README pull request as "merged but not on uat" |
| The same, after recording a UAT deployment of the latest commit | "Everything merged more than 0 hours ago is on uat." |

The Slack message itself wasn't tested here, because this repo has no webhook. Without one, the same text goes to the run log and summary.
