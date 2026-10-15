// drizzle-kit config: `npm run db:generate` diffs lib/db/schema.js against the
// existing migrations and writes the next one. Migrations are applied at runtime
// by src/server/streamingServer/lib/db/index.js.
module.exports = {
  dialect: 'sqlite',
  schema: './src/server/streamingServer/lib/db/schema.js',
  out: './src/server/streamingServer/lib/db/migrations'
};
