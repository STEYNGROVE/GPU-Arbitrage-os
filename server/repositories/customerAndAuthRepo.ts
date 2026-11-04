import { BasePostgresRepository } from './baseRepo.js';
import { Customer, CustomerApiKey, CustomerSession } from './types.js';

export class CustomerRepository extends BasePostgresRepository {
  public async findById(customerId: string): Promise<Customer | null> {
    const res = await this.query(
      `SELECT customer_id as "customerId", name, email, status, kyc_status as "kycStatus", 
              credit_limit::float as "creditLimit", created_at as "createdAt"
       FROM customers WHERE customer_id = $1`,
      [customerId]
    );
    return res.rows[0] || null;
  }

  public async create(customer: {
    customerId: string;
    name: string;
    email: string;
    status?: 'ACTIVE' | 'SUSPENDED';
    kycStatus?: 'PENDING' | 'VERIFIED' | 'REJECTED';
    creditLimit?: number;
  }): Promise<Customer> {
    const res = await this.query(
      `INSERT INTO customers (customer_id, name, email, status, kyc_status, credit_limit, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING customer_id as "customerId", name, email, status, kyc_status as "kycStatus",
                 credit_limit::float as "creditLimit", created_at as "createdAt"`,
      [
        customer.customerId,
        customer.name,
        customer.email,
        customer.status || 'ACTIVE',
        customer.kycStatus || 'PENDING',
        customer.creditLimit || 0.00
      ]
    );
    return res.rows[0];
  }

  public async listAll(): Promise<Customer[]> {
    const res = await this.query(
      `SELECT customer_id as "customerId", name, email, status, kyc_status as "kycStatus",
              credit_limit::float as "creditLimit", created_at as "createdAt"
       FROM customers ORDER BY created_at DESC`
    );
    return res.rows;
  }

  public async findAll(): Promise<Customer[]> {
    return this.listAll();
  }

  public async createCustomer(customer: {
    customerId: string;
    name: string;
    email: string;
    status?: 'ACTIVE' | 'SUSPENDED';
    kycStatus?: 'PENDING' | 'VERIFIED' | 'REJECTED';
    creditLimit?: number;
  }): Promise<Customer> {
    return this.create(customer);
  }
}

export class AuthRepository extends BasePostgresRepository {
  public async findApiKeyByHash(keyHash: string): Promise<CustomerApiKey | null> {
    const res = await this.query(
      `SELECT key_id as "keyId", customer_id as "customerId", key_hash as "keyHash",
              key_prefix as "keyPrefix", created_at as "createdAt", expires_at as "expiresAt",
              revoked_at as "revokedAt", last_used_at as "lastUsedAt", status
       FROM customer_api_keys
       WHERE key_hash = $1`,
      [keyHash]
    );
    return res.rows[0] || null;
  }

  public async findCustomerByRawKey(rawKey: string): Promise<{ customer: Customer; apiKey: CustomerApiKey } | null> {
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
    const apiKey = await this.findApiKeyByHash(hash);
    if (!apiKey || apiKey.status !== 'ACTIVE') return null;
    if (new Date(apiKey.expiresAt).getTime() < Date.now()) return null;

    const res = await this.query(
      `SELECT customer_id as "customerId", name, email, status, kyc_status as "kycStatus",
              credit_limit::float as "creditLimit", created_at as "createdAt"
       FROM customers WHERE customer_id = $1`,
      [apiKey.customerId]
    );
    const customer = res.rows[0];
    if (!customer || customer.status !== 'ACTIVE') return null;

    await this.updateApiKeyLastUsed(apiKey.keyId);
    return { customer, apiKey };
  }

  public async createApiKey(apiKey: {
    keyId: string;
    customerId: string;
    keyHash: string;
    keyPrefix: string;
    expiresAt: string;
  }): Promise<CustomerApiKey> {
    const res = await this.query(
      `INSERT INTO customer_api_keys (key_id, customer_id, key_hash, key_prefix, created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, NOW(), $5, 'ACTIVE')
       RETURNING key_id as "keyId", customer_id as "customerId", key_hash as "keyHash",
                 key_prefix as "keyPrefix", created_at as "createdAt", expires_at as "expiresAt",
                 revoked_at as "revokedAt", last_used_at as "lastUsedAt", status`,
      [apiKey.keyId, apiKey.customerId, apiKey.keyHash, apiKey.keyPrefix, apiKey.expiresAt]
    );
    return res.rows[0];
  }

  public async createCustomerApiKey(
    customerId: string,
    keyPrefix: string,
    keyHash: string,
    expiresAt: string
  ): Promise<CustomerApiKey> {
    const keyId = `key_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    return this.createApiKey({ keyId, customerId, keyHash, keyPrefix, expiresAt });
  }

  public async updateApiKeyLastUsed(keyId: string): Promise<void> {
    await this.query(
      `UPDATE customer_api_keys SET last_used_at = NOW() WHERE key_id = $1`,
      [keyId]
    );
  }

  public async revokeApiKey(keyId: string): Promise<void> {
    await this.query(
      `UPDATE customer_api_keys SET status = 'REVOKED', revoked_at = NOW() WHERE key_id = $1`,
      [keyId]
    );
  }

  public async createSession(session: {
    sessionId: string;
    userId: string;
    role: 'OWNER' | 'CUSTOMER';
    customerId?: string | null;
    permissions: string[];
    expiresAt: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<CustomerSession> {
    const res = await this.query(
      `INSERT INTO customer_sessions (session_id, user_id, role, customer_id, permissions, created_at, expires_at, last_seen_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW(), $7, $8)
       RETURNING session_id as "sessionId", user_id as "userId", role, customer_id as "customerId",
                 permissions, created_at as "createdAt", expires_at as "expiresAt", revoked_at as "revokedAt",
                 last_seen_at as "lastSeenAt", ip_address as "ipAddress", user_agent as "userAgent"`,
      [
        session.sessionId,
        session.userId,
        session.role,
        session.customerId || null,
        JSON.stringify(session.permissions),
        session.expiresAt,
        session.ipAddress || null,
        session.userAgent || null
      ]
    );
    return res.rows[0];
  }

  public async findSessionById(sessionId: string): Promise<CustomerSession | null> {
    const res = await this.query(
      `SELECT session_id as "sessionId", user_id as "userId", role, customer_id as "customerId",
              permissions, created_at as "createdAt", expires_at as "expiresAt", revoked_at as "revokedAt",
              last_seen_at as "lastSeenAt", ip_address as "ipAddress", user_agent as "userAgent"
       FROM customer_sessions
       WHERE session_id = $1`,
      [sessionId]
    );
    return res.rows[0] || null;
  }

  public async updateSessionLastSeen(sessionId: string): Promise<void> {
    await this.query(
      `UPDATE customer_sessions SET last_seen_at = NOW() WHERE session_id = $1`,
      [sessionId]
    );
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.query(
      `UPDATE customer_sessions SET revoked_at = NOW() WHERE session_id = $1`,
      [sessionId]
    );
  }
}
