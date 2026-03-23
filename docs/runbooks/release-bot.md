# Release Bot Runbook

## Overview

This service accepts `/asc`, bot DMs, and mention-started Slack threads, uses OpenAI to normalize English or Japanese release requests, resolves the concrete App Store Connect target with `asc`, and requires an explicit Slack approval before it performs any write action.

Implemented v1 action set:

- `resolve_latest_build`
- `validate_release`
- `prepare_release_for_review`
- `submit_release_for_review`
- `release_status`

## Prerequisites

- Node.js 22 or newer
- `pnpm` via `npx pnpm`
- PostgreSQL 15 or newer
- Slack app with slash commands and interactivity enabled
- App Store Connect API key material
- OpenAI API key
- Azure subscription, resource group, and Azure Container Registry

## Local Setup

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `DATABASE_URL`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_BOT_TOKEN`
   - `OPENAI_API_KEY`
   - `ASC_KEY_ID`
   - `ASC_ISSUER_ID`
   - `ASC_PRIVATE_KEY_B64`
   - `SERVICE_BUS_CONNECTION_STRING`
3. Install dependencies:

```bash
npx pnpm install
```

4. Apply the database schema:

```bash
npx pnpm db:migrate
```

5. Seed at least one Slack operator and one app alias:

```sql
INSERT INTO slack_users (slack_user_id, display_name, role, is_active)
VALUES
  ('U0123456789', 'Release Admin', 'admin', true)
ON CONFLICT (slack_user_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    role = EXCLUDED.role,
    is_active = EXCLUDED.is_active;

INSERT INTO app_aliases (alias, provider, app_id, platform, metadata)
VALUES
  ('my-ios-app', 'apple', '123456789', 'IOS', '{}'::jsonb)
ON CONFLICT (alias) DO UPDATE
SET provider = EXCLUDED.provider,
    app_id = EXCLUDED.app_id,
    platform = EXCLUDED.platform,
    metadata = EXCLUDED.metadata;
```

6. Build the workspace:

```bash
npx pnpm build
```

7. Run the API and worker:

```bash
npx pnpm dev:api
npx pnpm dev:worker
```

## Slack App Configuration

Required Slack scopes:

- `commands`
- `chat:write`
- `app_mentions:read`
- `im:history`
- `channels:history`
- `groups:history`

Recommended Slack settings:

- Slash command: `/asc`
- Request URL: `https://<api-host>/slack/events`
- Interactivity Request URL: `https://<api-host>/slack/events`
- Event Subscriptions Request URL: `https://<api-host>/slack/events`
- Bot events:
  - `app_mention`
  - `message.im`
  - `message.channels`
  - `message.groups`
- Enable the App Home messages tab so users can DM the bot directly.

Operational notes:

- Invite the bot to every channel where you want execution status messages.
- `/asc` in a channel starts a bot-owned planning thread in that channel.
- Mentioning the bot in a thread starts or resumes the planning conversation in that thread.
- DMs with the bot are handled as a persistent conversation surface without a modal.
- The database allowlist is the source of truth. Slack channel membership or display names are not trusted for authorization.

## App Store Connect Credentials

Create an App Store Connect API key with the minimum role required to validate and submit builds.

Convert the `.p8` file to base64 for environment or Key Vault storage:

```bash
base64 -i "AuthKey_ABC1234567.p8" | tr -d '\n'
```

Populate:

- `ASC_KEY_ID`
- `ASC_ISSUER_ID`
- `ASC_PRIVATE_KEY_B64`

The API and worker expect `asc` to run headlessly with:

- `ASC_BYPASS_KEYCHAIN=1`
- `ASC_NO_UPDATE=1`

## OpenAI Command Planning

The bot uses OpenAI before provider resolution so operators can write commands naturally in English or Japanese, ask follow-up questions in a thread or DM, and revise a plan over multiple turns. It also uses OpenAI to turn raw `asc status` JSON into a concise Slack summary.

Example phrases:

- `submit the latest 1.3.7 TestFlight to Apple for public release`
- `1.3.7 の最新 TestFlight ビルドを Apple の公開リリース審査に提出して`
- `show release status for my-ios-app`

The planner only returns a typed action. The actual `asc` commands are built by the Apple provider and shown back in Slack before approval.

## Azure Deployment

### 1. Build and push container images

```bash
az acr build --registry <acr-name> --image store-agent/api:latest --file apps/api/Dockerfile .
az acr build --registry <acr-name> --image store-agent/worker:latest --file apps/worker/Dockerfile .
```

### 2. Enable ACR ARM-token auth for managed identity pulls

The Bicep template uses user-assigned managed identities plus `AcrPull` role assignments instead of ACR admin credentials. Enable ARM audience tokens on the registry once:

```bash
az acr config authentication-as-arm update -r <acr-name> --status enabled
```

### 3. Deploy infrastructure

Copy `infra/bicep/main.parameters.example.json` to your own parameter file and replace the placeholders, then deploy:

- `containerRegistryName` should be your ACR name such as `kotoba`
- `containerRegistryResourceGroup` should be the resource group that owns the ACR
- If your ACR lives in a different subscription, also set `containerRegistrySubscriptionId`

```bash
az deployment group create \
  --resource-group <resource-group> \
  --template-file infra/bicep/main.bicep \
  --parameters @infra/bicep/main.parameters.json
```

The Bicep stack provisions:

- Azure Container Apps environment
- API container app
- Service Bus namespace and queue
- worker Container Apps Job
- Key Vault with secrets
- PostgreSQL Flexible Server and database
- Log Analytics workspace

### 4. Run database migration against Azure PostgreSQL

Use the Azure database connection string from the Key Vault secret or compose it from the deployment outputs:

```bash
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/store_agent?sslmode=require" \
SLACK_SIGNING_SECRET="placeholder" \
SLACK_BOT_TOKEN="placeholder" \
OPENAI_API_KEY="placeholder" \
SERVICE_BUS_CONNECTION_STRING="Endpoint=sb://placeholder/" \
npx pnpm db:migrate
```

### 5. Seed operators and app aliases

Run the SQL seed statements against the Azure PostgreSQL database before testing Slack commands.

### 6. Point Slack at Azure

Set the slash command, interactivity, and Event Subscriptions URLs to:

```text
https://<container-app-fqdn>/slack/events
```

## Release Flow

1. Operator starts with `/asc`, a DM to the bot, or a bot mention in a thread.
2. Slack creates or resumes a conversation in the same DM or thread.
3. OpenAI either asks a follow-up question or returns a typed action.
4. The Apple provider resolves the exact build and preflight plan with `asc`.
5. Slack shows the exact `asc` commands in the same DM or thread and waits for confirmation.
6. Confirmation enqueues a Service Bus job.
7. The worker revalidates the build and runs the write command.
8. Slack posts the success or failure message back into the same DM or thread.

## Troubleshooting

### Slash command returns an authorization error

- Confirm the Slack user exists in `slack_users`.
- Confirm `is_active = true`.
- For approval clicks, confirm the user role is `approver` or `admin`.

### The conversation plans the wrong app or version

- Reply in the same thread or DM with the corrected app alias, version, or release notes.
- Start a fresh `/asc` conversation if you want to discard the current planning context.
- Review the OpenAI model and prompt output in logs.
- Prefer stable app aliases such as `my-ios-app`.

### DMs or mention threads do not trigger the bot

- Confirm the Slack app was reinstalled after adding new OAuth scopes.
- Confirm Event Subscriptions are enabled and pointing at `https://<api-host>/slack/events`.
- Confirm the bot events `app_mention`, `message.im`, `message.channels`, and `message.groups` are subscribed.
- Confirm the App Home messages tab is enabled for direct messages.

### `asc` command fails in Azure

- Confirm the container image includes `asc` and `PATH` includes `/root/.local/bin`.
- Confirm `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_B64` are present in Key Vault.
- Check whether the API key role is sufficient for validation and submission.

### Worker never executes queued jobs

- Confirm the Service Bus queue name matches `SERVICE_BUS_QUEUE_NAME`.
- Inspect the Container Apps Job execution history and Log Analytics.
- Confirm the Service Bus connection string secret is mounted into both the API and worker.

### Container Apps cannot pull images from ACR

- Confirm `az acr config authentication-as-arm update -r <acr-name> --status enabled` has been run for the registry.
- Confirm the deployment parameter `containerRegistryName` matches the real ACR name.
- If the ACR lives in another resource group or subscription, set `containerRegistryResourceGroup` and `containerRegistrySubscriptionId` correctly.
- Check that the `AcrPull` role assignments were created for both user-assigned identities on the registry.

## Known Limits

- Google Play is not implemented yet, but the provider boundary is ready for it.
- The release mode is captured in the approval plan, but `asc submit create` is the only write path wired in v1. Validate any extra release-mode flags against the installed `asc` version before broadening the workflow.
