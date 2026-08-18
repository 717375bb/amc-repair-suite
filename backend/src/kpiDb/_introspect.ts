import 'dotenv/config';
import { queryKpiDb, closeKpiDbPool } from './client.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('kpidb');

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
  const columns = await queryKpiDb<ColumnRow>(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${table}'
     ORDER BY ORDINAL_POSITION`,
  );
  const columnSummaries = columns.map(
    (c) =>
      `${c.COLUMN_NAME}: ${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : ''} ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`,
  );

  const rows = await queryKpiDb(`SELECT TOP 5 * FROM [${schema}].[${table}]`);

  log.info(
    { schema, table, columnCount: columns.length, columns: columnSummaries, sampleRows: rows },
    `===== ${schema}.${table} =====`,
  );
}

async function checkReadOnly(): Promise<void> {
  const roles = await queryKpiDb<{ role: string; isMember: number }>(
    `SELECT 'db_datareader' AS role, IS_ROLEMEMBER('db_datareader') AS isMember
     UNION ALL SELECT 'db_datawriter', IS_ROLEMEMBER('db_datawriter')
     UNION ALL SELECT 'db_ddladmin', IS_ROLEMEMBER('db_ddladmin')
     UNION ALL SELECT 'db_owner', IS_ROLEMEMBER('db_owner')`,
  );

  const perms = await queryKpiDb<{ permission_name: string; state_desc: string }>(
    `SELECT permission_name, state_desc FROM fn_my_permissions(NULL, 'DATABASE')
     WHERE permission_name IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL')`,
  );

  log.info(
    { roles, writeShapedPermissions: perms },
    '===== permission check =====',
  );
}

async function main(): Promise<void> {
  const brzOrdersLocations = await findTable('BRZ_Orders');
  log.info({ brzOrdersLocations }, 'BRZ_Orders located at');

  for (const loc of brzOrdersLocations) {
    await describeTable(loc.TABLE_SCHEMA, loc.TABLE_NAME);
  }
  await describeTable('brz', 'orderlines');
  await describeTable('brz', 'invoice');

  await checkReadOnly();

  await closeKpiDbPool();
}

main().catch((err) => {
  log.error({ err }, 'kpiDb introspection failed');
  process.exitCode = 1;
});
