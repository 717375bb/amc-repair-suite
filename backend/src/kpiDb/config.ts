import type { config as SqlConfig } from 'mssql';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getKpiDbConfig(): SqlConfig {
  return {
    server: requireEnv('KPI_DB_SERVER'),
    database: requireEnv('KPI_DB_NAME'),
    user: requireEnv('KPI_DB_USER'),
    password: requireEnv('KPI_DB_PASSWORD'),
    options: {
      // Azure SQL requires encrypted connections.
      encrypt: true,
      trustServerCertificate: false,
    },
  };
}
