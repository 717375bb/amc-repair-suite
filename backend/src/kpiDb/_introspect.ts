import 'dotenv/config';
import { queryKpiDb, closeKpiDbPool } from './client.js';

type ColumnRow = {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  IS_NULLABLE: string;
  ORDINAL_POSITION: number;
};

type TableLocationRow = { TABLE_SCHEMA: string; TABLE_NAME: string };

async function findTable(tableName: string): Promise<TableLocationRow[]> {
  return queryKpiDb<TableLocationRow>(
    `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${tableName}'`,
  );
}

async function describeTable(schema: string, table: string): Promise<void> {
  console.log(`\n===== ${schema}.${table} =====`);

  const columns = await queryKpiDb<ColumnRow>(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${table}'
     ORDER BY ORDINAL_POSITION`,
  );
  console.log(`-- columns (${columns.length}) --`);
  for (const c of columns) {
    const len = c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : '';
    console.log(`  ${c.COLUMN_NAME}: ${c.DATA_TYPE}${len} ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`);
  }

  console.log(`-- sample rows (TOP 5) --`);
  const rows = await queryKpiDb(`SELECT TOP 5 * FROM [${schema}].[${table}]`);
  console.log(JSON.stringify(rows, null, 2));
}

async function checkReadOnly(): Promise<void> {
  console.log(`\n===== permission check =====`);
  const roles = await queryKpiDb<{ role: string; isMember: number }>(
    `SELECT 'db_datareader' AS role, IS_ROLEMEMBER('db_datareader') AS isMember
     UNION ALL SELECT 'db_datawriter', IS_ROLEMEMBER('db_datawriter')
     UNION ALL SELECT 'db_ddladmin', IS_ROLEMEMBER('db_ddladmin')
     UNION ALL SELECT 'db_owner', IS_ROLEMEMBER('db_owner')`,
  );
  for (const r of roles) {
    console.log(`  ${r.role}: ${r.isMember}`);
  }

  const perms = await queryKpiDb<{ permission_name: string; state_desc: string }>(
    `SELECT permission_name, state_desc FROM fn_my_permissions(NULL, 'DATABASE')
     WHERE permission_name IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL')`,
  );
  console.log(`-- write-shaped database permissions granted --`);
  if (perms.length === 0) {
    console.log('  none found');
  }
  for (const p of perms) {
    console.log(`  ${p.permission_name}: ${p.state_desc}`);
  }
}

async function main(): Promise<void> {
  const brzOrdersLocations = await findTable('BRZ_Orders');
  console.log('BRZ_Orders located at:', brzOrdersLocations);

  for (const loc of brzOrdersLocations) {
    await describeTable(loc.TABLE_SCHEMA, loc.TABLE_NAME);
  }
  await describeTable('brz', 'orderlines');
  await describeTable('brz', 'invoice');

  await checkReadOnly();

  await closeKpiDbPool();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
