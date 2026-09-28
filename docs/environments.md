# RichesPay environments

Each environment has its own Supabase project, Redis instance, encryption key, API key pepper, and Sentry project. Do not copy secrets between them.

| Environment | `DEPLOY_ENV` | `APP_ENV` | Purpose |
| --- | --- | --- | --- |
| dev | `development` | `development` | Local and shared development |
| staging | `staging` | `production` | Release candidate with production behaviour |
| production | `production` | `production` | Live merchant traffic |

Browser apps are static builds. Pass the matching `VITE_*` values for that environment at image build time. The API and worker read only server environment variables.

Secrets live in the GitHub Environment (`staging` and `production`), not in git. Required names: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, plus the API env file on the host.

The production GitHub Environment must require a reviewer. The release workflow deploys staging first, then waits on that approval before production.

## Releases

Migrations must stay backward compatible for one release. Add columns and tables first. Do not rename or drop a column until the following release is running everywhere. The workflow applies migrations before the rolling restart so the previous API process can still serve traffic during the change.

