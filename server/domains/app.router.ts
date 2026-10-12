import { os } from '@orpc/server'
// App router: merge every module router. Server routes/rpc/[...].ts imports
// this to build the oRPC handler. Adding a resource = new module folder with
// X.router.ts (+ X.service.ts when logic outgrows the handlers) + registration
// here.
import { metaRouter } from './meta/meta.router'
import { authRouter } from './auth/auth.router'
import { settingsRouter } from './settings/settings.router'
import { oidcRouter } from './oidc/oidc.router'
import { providersRouter } from './providers/providers.router'
import { projectsRouter } from './projects/projects.router'
import { statusesRouter } from './statuses/statuses.router'
import { tasksRouter } from './tasks/tasks.router'
import { employeesRouter } from './employees/employees.router'
import { environmentsRouter } from './environments/environments.router'
import { vaultRouter } from './vault/vault.router'

export const appRouter = os.router({
  meta: metaRouter,
  auth: authRouter,
  settings: settingsRouter,
  oidc: oidcRouter,
  providers: providersRouter,
  projects: projectsRouter,
  statuses: statusesRouter,
  tasks: tasksRouter,
  employees: employeesRouter,
  environments: environmentsRouter,
  vault: vaultRouter,
})
