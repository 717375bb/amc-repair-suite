import type { config as SqlConfig } from 'mssql';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getKpiDbConfig(): SqlConfig {
  // SECURITY TODO: route KPI_DB_* through secretProvider (see
  // backend/src/security/secretProvider.ts) when this module is actually
  // wired into a running code path. Deliberately NOT done as part of the
  // #6-hardening secrets-seam work — this whole module is still dead code
  // (never called from any live route, per privacy.md), and routing an
  // unused path risks guessing at requirements for a feature that doesn't
  // run yet. This comment is the tripwire so it can't get wired in live
  // later while silently staying on a raw process.env read.
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
