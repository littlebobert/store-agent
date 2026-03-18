# Release Bot Runbook

## Overview

This service accepts `/asc` commands in Slack, uses OpenAI to normalize English or Japanese release requests, resolves the concrete App Store Connect target with `asc`, and requires an explicit Slack approval before it performs any write action.

Implemented v1 action set:

- `resolve_latest_build`
- `validate_release`
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

Recommended Slack settings:

- Slash command: `/asc`
- Request URL: `https://<api-host>/slack/events`
- Interactivity Request URL: `https://<api-host>/slack/events`

Operational notes:

- Invite the bot to every channel where you want execution status messages.
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

The bot uses OpenAI before provider resolution so operators can write commands naturally in English or Japanese.

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

### 2. Deploy infrastructure

Copy `infra/bicep/main.parameters.example.json` to your own parameter file and replace the placeholders, then deploy:

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

### 3. Run database migration against Azure PostgreSQL

Use the Azure database connection string from the Key Vault secret or compose it from the deployment outputs:

```bash
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/store_agent?sslmode=require" \
SLACK_SIGNING_SECRET="placeholder" \
SLACK_BOT_TOKEN="placeholder" \
OPENAI_API_KEY="placeholder" \
SERVICE_BUS_CONNECTION_STRING="Endpoint=sb://placeholder/" \
npx pnpm db:migrate
```

### 4. Seed operators and app aliases

Run the SQL seed statements against the Azure PostgreSQL database before testing Slack commands.

### 5. Point Slack at Azure

Set the slash command and interactivity URLs to:

```text
https://<container-app-fqdn>/slack/events
```

## Release Flow

1. Operator runs `/asc`.
2. Slack modal collects the free-form command plus optional overrides.
3. OpenAI normalizes the request.
4. The Apple provider resolves the exact build and preflight plan with `asc`.
5. Slack shows the exact `asc` commands and waits for confirmation.
6. Confirmation enqueues a Service Bus job.
7. The worker revalidates the build and runs the write command.
8. Slack receives a success or failure message.

## Troubleshooting

### Slash command returns an authorization error

- Confirm the Slack user exists in `slack_users`.
- Confirm `is_active = true`.
- For approval clicks, confirm the user role is `approver` or `admin`.

### The modal plans the wrong app or version

- Use the modal overrides for `app alias` and `version`.
- Review the OpenAI model and prompt output in logs.
- Prefer stable app aliases such as `my-ios-app`.

### `asc` command fails in Azure

- Confirm the container image includes `asc` and `PATH` includes `/root/.local/bin`.
- Confirm `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_B64` are present in Key Vault.
- Check whether the API key role is sufficient for validation and submission.

### Worker never executes queued jobs

- Confirm the Service Bus queue name matches `SERVICE_BUS_QUEUE_NAME`.
- Inspect the Container Apps Job execution history and Log Analytics.
- Confirm the Service Bus connection string secret is mounted into both the API and worker.

## Known Limits

- Google Play is not implemented yet, but the provider boundary is ready for it.
- The release mode is captured in the approval plan, but `asc submit create` is the only write path wired in v1. Validate any extra release-mode flags against the installed `asc` version before broadening the workflow.
