const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('portal lookup prefers an active row over a disabled one', () => {
  const sql = fs.readFileSync('supabase-portal-ativo.sql', 'utf8');
  assert.match(sql, /coalesce\(c->>'ativo', 'true'\) <> 'false'\) desc/);
  assert.equal(sql.includes("= 'false') desc"), false);
});
