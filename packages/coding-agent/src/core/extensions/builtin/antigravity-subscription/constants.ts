export const ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID = "antigravity-subscription";
export const ANTIGRAVITY_SUBSCRIPTION_API_ID = "antigravity-subscription";
export const ANTIGRAVITY_SUBSCRIPTION_NAME = "Antigravity (agy CLI)";
export const BRIDGE_SERVER_NAME = "senpi-host";
export const AGENT_NAME = "senpi-host";
export const SETTINGS_KEY = "antigravitySubscriptionProvider";

/** Written into agy's global settings only after the user consents during `/login`. */
export const PERMISSION_RULE = `mcp(${BRIDGE_SERVER_NAME}/*)`;

/** agy authenticates itself; this non-empty marker satisfies senpi's auth layer and is never sent anywhere. */
export const SENTINEL_API_KEY = "antigravity-ambient";
