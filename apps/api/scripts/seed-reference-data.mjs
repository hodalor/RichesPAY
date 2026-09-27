import "dotenv/config";
import pg from "pg";

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await db.connect();
await db.query("begin");

try {
  await db.query(`
    insert into public.countries (code, name, currency, timezone, dial_code, enabled)
    values
      ('GH', 'Ghana', 'GHS', 'Africa/Accra', '+233', true),
      ('ZM', 'Zambia', 'ZMW', 'Africa/Lusaka', '+260', true)
    on conflict (code) do update
    set
      name = excluded.name,
      currency = excluded.currency,
      timezone = excluded.timezone,
      dial_code = excluded.dial_code,
      enabled = excluded.enabled
  `);

  const msisdnTable = await db.query(
    "select to_regclass('public.msisdn_prefixes') as name"
  );

  if (msisdnTable.rows[0]?.name) {
    await db.query(`
      insert into public.msisdn_prefixes (country_code, prefix, network)
      values
        ('GH', '23320', 'telecel'),
        ('GH', '23323', 'telecel'),
        ('GH', '23324', 'mtn'),
        ('GH', '23326', 'at'),
        ('GH', '23327', 'at'),
        ('GH', '23350', 'telecel'),
        ('GH', '23353', 'telecel'),
        ('GH', '23354', 'mtn'),
        ('GH', '23355', 'mtn'),
        ('GH', '23356', 'at'),
        ('GH', '23357', 'at'),
        ('GH', '23359', 'mtn'),
        ('ZM', '26095', 'zamtel'),
        ('ZM', '26096', 'airtel'),
        ('ZM', '26097', 'mtn')
      on conflict (country_code, prefix) do update
      set network = excluded.network
    `);
  }

  await db.query("commit");
} catch (error) {
  await db.query("rollback");
  throw error;
} finally {
  await db.end();
}

console.log(
  JSON.stringify(
    {
      seeded: true,
      countries: ["GH", "ZM"]
    },
    null,
    2
  )
);
