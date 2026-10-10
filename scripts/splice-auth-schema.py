import re, subprocess

r = subprocess.run(['bunx', 'auth', 'generate', '--config', 'scripts/auth.config.ts', '--output', '/tmp/tandem-auth-schema.ts', '-y'], capture_output=True, text=True)
assert r.returncode == 0, r.stderr[-400:]
gen = open('/tmp/tandem-auth-schema.ts').read()

# keep only the table definitions (drop imports + relations part)
tables = re.findall(r'export const (\w+) = pgTable\("(\w+)"(.*?)\n\]\);', gen, flags=re.S)
out = []
for name, tbl, body in tables:
    out.append(f'export const {name} = pgTable(\'tandem_{name}\'{body.rstrip()}\n]);' if body.rstrip().endswith('}, (table) => [') else None)
# simpler: manual assembly per table below
def table(name, body):
    return f"export const {name} = pgTable('tandem_{name}', {{{body}}})\n"

# Extract each table's column block with the generator's own text, normalized:
def grab(name):
    m = re.search(rf'export const {name} = pgTable\("\w+", \{{(.*?)\}}(, \(table\) => \[(.*?)\])?\);', gen, flags=re.S)
    if not m:
        raise SystemExit(f'missing {name}')
    cols = m.group(1)
    idx = m.group(3) or ''
    cols = re.sub(r'\t+', '', cols)
    cols = re.sub(r'\n {2,}', '\n  ', cols).strip()
    cols = cols.replace('"', "'")
    cols = re.sub(r"timestamp\('([a-z_]+)'\)", r"timestamp('\1', { withTimezone: true })", cols)
    cols = re.sub(r"timestamp\('([a-z_]+)', \{ withTimezone: true \}\)\.defaultNow\(\)\.notNull\(\)\.\$onUpdate\(\(\) => /\* @__PURE__ \*/ new Date\(\)\)\.notNull\(\)",
                  r"timestamp('\1', { withTimezone: true }).notNull().defaultNow()", cols)
    cols = re.sub(r"timestamp\('([a-z_]+)', \{ withTimezone: true \}\)\.\$onUpdate\(\(\) => /\* @__PURE__ \*/ new Date\(\)\)\.notNull\(\)",
                  r"timestamp('\1', { withTimezone: true }).notNull()", cols)
    idx = idx.replace('"', "'").strip()
    return cols, idx

header = '''// Drizzle rc (Relations v2) over Postgres.
// Auth tables (tandem_user/session/account/verification/apikey) are GENERATED
// by the better-auth CLI — regenerate with `bun run gen:auth`; never edit by
// hand. Domain tables below are hand-owned.
import { pgTable, text, timestamp, boolean, integer, index, primaryKey, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { defineRelations } from 'drizzle-orm'

'''

parts = [header, '// >>> BEGIN GENERATED better-auth tables (bun run gen:auth) — do not edit by hand\n']
# FK + cascade additions for tandem semantics
EXTRA = {
    'apikey': {
        'insert_after': "referenceId: text('reference_id').notNull(),",
        'replace_with': "referenceId: text('reference_id').notNull().references(() => user.id, { onDelete: 'cascade' }),",
    },
}
for name in ['user', 'session', 'account', 'verification', 'apikey']:
    cols, idx = grab(name)
    if name == 'apikey':
        cols = cols.replace("referenceId: text('reference_id').notNull(),",
                            "referenceId: text('reference_id').notNull().references(() => user.id, { onDelete: 'cascade' }),")
    if idx:
        parts.append(f"export const {name} = pgTable('tandem_{name}', {{\n  {cols},\n}}, (t) => [\n  {idx},\n])\n\n")
    else:
        parts.append(f"export const {name} = pgTable('tandem_{name}', {{\n  {cols},\n}})\n\n")
parts.append('// <<< END GENERATED better-auth tables\n\n')

domain = '''// ---------- Tandem domain tables (hand-owned) ----------

// SSH targets that run the Hermes agent (M2).
export const environments = pgTable('tandem_environments', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: text('port').notNull().default('22'),
  username: text('username').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// runtime key/value settings (oidc providers JSON, flags, …)
export const settings = pgTable('tandem_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Supervision is many-to-many: one employee may have many supervisors.
// Users ARE employees, so both columns reference tandem_user.
// Self-supervision is structurally impossible (CHECK).
export const employeeSupervisors = pgTable('tandem_employee_supervisors', {
  employeeId: text('employee_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  supervisorId: text('supervisor_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.employeeId, t.supervisorId] }),
  check('no_self_supervision', sql`${t.supervisorId} <> ${t.employeeId}`),
  index('tandem_employee_supervisors_supervisor_idx').on(t.supervisorId),
])

// AI extension (1:1 with user): row existence marks the employee as an AI
// agent; absence = human employee. No kind column anywhere.
export const aiEmployees = pgTable('tandem_ai_employees', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'restrict' }),
  instructions: text('instructions').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------- relations ----------

export const relations = defineRelations(
  { user, session, account, verification, settings, environments, employeeSupervisors, aiEmployees, apikey },
  (helpers) => ({
    user: {
      sessions: helpers.many.session({ from: helpers.user.id, to: helpers.session.userId }),
      accounts: helpers.many.account({ from: helpers.user.id, to: helpers.account.userId }),
      supervisors: helpers.many.employeeSupervisors({ from: helpers.user.id, to: helpers.employeeSupervisors.employeeId }),
      ai: helpers.one.aiEmployees({ from: helpers.user.id, to: helpers.aiEmployees.userId }),
      apiKeys: helpers.many.apikey({ from: helpers.user.id, to: helpers.apikey.referenceId }),
    },
    session: {
      user: helpers.one.user({ from: helpers.session.userId, to: helpers.user.id }),
    },
    account: {
      user: helpers.one.user({ from: helpers.account.userId, to: helpers.user.id }),
    },
    employeeSupervisors: {
      employees: helpers.one.user({ from: helpers.employeeSupervisors.employeeId, to: helpers.user.id }),
      supervisors: helpers.one.user({ from: helpers.employeeSupervisors.supervisorId, to: helpers.user.id }),
    },
    aiEmployees: {
      users: helpers.one.user({ from: helpers.aiEmployees.userId, to: helpers.user.id }),
      environments: helpers.one.environments({ from: helpers.aiEmployees.environmentId, to: helpers.environments.id }),
    },
    apikey: {
      users: helpers.one.user({ from: helpers.apikey.referenceId, to: helpers.user.id }),
    },
    environments: {},
    settings: {},
    verification: {},
  }),
)

export const authSchema = {
  user,
  session,
  account,
  verification,
  apikey,
}
'''
parts.append(domain)
open('server/db/schema.ts', 'w').write(''.join(parts))
print('schema.ts rewritten from generated + domain')
