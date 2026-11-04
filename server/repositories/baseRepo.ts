import type pg from 'pg';
import { pgDbService } from '../pgDatabase.js';

export class DatabaseUnavailableError extends Error {
  constructor(message = 'PostgreSQL is unavailable. Live financial operations are blocked.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export class TransactionFailedError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'TransactionFailedError';
  }
}

export abstract class BasePostgresRepository {
  protected assertConnected(): void {
    if (!pgDbService.isLiveDatabaseConnected()) {
      throw new DatabaseUnavailableError();
    }
  }

  protected async query<T = any>(sql: string, params: any[] = []): Promise<pg.QueryResult<T>> {
    this.assertConnected();
    return pgDbService.query(sql, params);
  }

  protected async withTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    this.assertConnected();
    const client = await pgDbService.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr: any) {
        console.error('[TRANSACTION ROLLBACK FAILED]', rollbackErr.message);
      }
      throw new TransactionFailedError(`PostgreSQL transaction failed: ${err.message}`, err);
    } finally {
      client.release();
    }
  }
}
