// FILE: src/config/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Application configuration and environment management
//   SCOPE: Load, validate, and provide application configuration
//   DEPENDS: none
//   LINKS: M-CONFIG
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   loadConfig - Load and validate configuration
//   AppConfig - Configuration type definition
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial implementation
// END_CHANGE_SUMMARY

// START_CONTRACT: loadConfig
//   PURPOSE: Load and validate config from environment
//   INPUTS: {}
//   OUTPUTS: { AppConfig — validated configuration object }
//   SIDE_EFFECTS: none
// END_CONTRACT: loadConfig

export function loadConfig(): AppConfig {
  // START_BLOCK_VALIDATE
  const env = process.env.NODE_ENV || "development";
  if (!env) throw new Error("CONFIG_INVALID");
  // END_BLOCK_VALIDATE

  // START_BLOCK_LOAD
  return { env, port: Number(process.env.PORT) || 3000 };
  // END_BLOCK_LOAD
}

export interface AppConfig {
  env: string;
  port: number;
}
