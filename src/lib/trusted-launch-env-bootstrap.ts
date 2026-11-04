import { initializeTrustedLaunchEnv } from "./trusted-launch-env.mjs";

// This module must run before the CLI imports any environment-sensitive modules.
initializeTrustedLaunchEnv(process.env);
