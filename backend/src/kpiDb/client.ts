import sql from 'mssql';
import { getKpiDbConfig } from './config.js';

let pool: sql.ConnectionPool | null = null;

export async function getKpiDbPool(): Promise<sql.ConnectionPool> {
  if (pool) {
    return pool;
  }
  pool = await new sql.ConnectionPool(getKpiDbConfig()).connect();
  return pool;
}

export async function queryKpiDb<T = unknown>(
  query: string,
  inputs?: Record<string, { type: sql.ISqlType; value: unknown }>,
): Promise<T[]> {
  const connectedPool = await getKpiDbPool();
  const request = connectedPool.request();
  if (inputs) {
    for (const [name, { type, value }] of Object.entries(inputs)) {
      request.input(name, type, value);
    }
  }
  const result = await request.query<T>(query);
  return result.recordset;
}

export async function closeKpiDbPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
