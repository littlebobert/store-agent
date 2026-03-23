# Store Agent

Slack bot for App Store Connect release operations, designed for Azure deployment.

## What it does

- Accepts English or Japanese release requests through `/asc`, bot DMs, or mention-started Slack threads.
- Uses OpenAI to normalize the request into a typed action plus an app reference, and asks follow-up questions over multiple turns.
- Uses OpenAI to summarize store status output for Slack.
- Resolves the exact configured app alias and App Store Connect target with `asc`.
- Shows the exact `asc` plan in Slack before any write action runs and requires explicit confirmation.
- Queues confirmed jobs through Azure Service Bus and executes them in a worker.

## Workspace

- `apps/api`: Slack HTTP app, OpenAI command planner, approval flow, queue publisher.
- `apps/worker`: Service Bus driven executor for confirmed release jobs.
- `packages/core`: shared schemas, OpenAI planner, policy helpers, Postgres store.
- `packages/providers`: Apple `asc` provider and Google Play provider boundary.
- `infra/bicep`: Azure infrastructure definition.
- `docs/runbooks/release-bot.md`: deployment and operations guide.

## Quickstart

1. Copy `.env.example` to `.env` and fill in your local values.
2. Install dependencies with `npx pnpm install`.
3. Apply the database schema with `npx pnpm db:migrate`.
4. Seed `slack_users` and `app_aliases` as described in the runbook.
5. Build with `npx pnpm build`.
6. Start the API with `npx pnpm dev:api`.
7. Start the worker with `npx pnpm dev:worker`.

## Notes

- Apple App Store Connect flows are implemented in v1 through `asc`.
- Google Play is intentionally left behind the same provider interface and can be added next without changing the Slack approval flow.
- Both the API and worker containers install `asc` via the official install script during image build.
