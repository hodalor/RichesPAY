export { createDatabase, createDatabasePool, type AppDatabase } from "./client";
export {
  registerDatabase,
  runWithMerchantScope,
  runWithSystemScope,
  setRoleSwitchingEnabledForTests,
  type ScopedTransaction,
  withMerchantScope,
  withSystemScope
} from "./scope";
export type { DB, RpMode } from "./types";
