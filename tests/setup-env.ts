process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/molly_test";
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? "./storage-test";
process.env.APP_MODE = "demo";
