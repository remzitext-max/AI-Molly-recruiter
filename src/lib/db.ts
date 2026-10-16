import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { __prisma?: PrismaClient };
export const db: PrismaClient = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__prisma = db;
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
