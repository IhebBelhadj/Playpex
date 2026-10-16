// drizzle-kit config: `npm run db:generate` diffs lib/db/schema.js against the
// existing migrations and writes the next one. Migrations are applied at runtime
// by lib/db/index.js.
module.exports = {
  dialect: 'sqlite',
  schema: './lib/db/schema.js',
  out: './lib/db/migrations'
};
