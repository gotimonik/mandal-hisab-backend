import { MongoClient, type ClientSession, type Db, type TransactionOptions } from "mongodb";
import { env } from "@/config/env";

/**
 * Cached MongoDB connection.
 *
 * In development Next.js hot-reloads modules, so the client promise is stored on
 * `globalThis` to avoid opening a new pool on every reload. On Vercel each warm
 * serverless instance reuses the module-level promise.
 */
type Cache = { client?: MongoClient; promise?: Promise<MongoClient>; uri?: string };
const g = globalThis as unknown as { __mandalMongo?: Cache };
const cache: Cache = g.__mandalMongo ?? (g.__mandalMongo = {});

export async function getClient(): Promise<MongoClient> {
  const uri = env().MONGODB_URI;
  if (cache.client && cache.uri === uri) return cache.client;
  if (!cache.promise || cache.uri !== uri) {
    cache.uri = uri;
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 10_000,
      appName: "mandalhisab-api",
    });
    cache.promise = client.connect().then((c) => {
      cache.client = c;
      return c;
    });
    cache.promise.catch(() => {
      cache.promise = undefined;
    });
  }
  return cache.promise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env().MONGODB_DB);
}

export async function closeDb() {
  if (cache.client) await cache.client.close();
  cache.client = undefined;
  cache.promise = undefined;
}

const TXN_OPTS: TransactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
};

/**
 * Run `fn` inside a MongoDB multi-document transaction. The driver retries the
 * callback on TransientTransactionError / UnknownTransactionCommitResult, so `fn`
 * must be idempotent with respect to its own reads (it is: all writes are guarded).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = await getClient();
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async (s) => {
      result = await fn(s);
    }, TXN_OPTS);
    return result as T;
  } finally {
    await session.endSession();
  }
}
